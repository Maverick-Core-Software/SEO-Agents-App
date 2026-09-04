// Narrow Thumbtack Partner API v4 adapters.
// Read primitives are always available; write primitives are gated behind `allowWrites`.
// Tokens are never logged; errors log only HTTP status and x-request-id.
import {
  thumbtackApiBaseUrl,
  thumbtackClientId,
  thumbtackClientSecret,
  thumbtackOAuthTokenUrl,
  thumbtackProductionTokenStorePath,
  thumbtackStagingApiBaseUrl,
  thumbtackStagingClientId,
  thumbtackStagingClientSecret,
  thumbtackStagingOAuthTokenUrl,
  thumbtackTokenEncryptionKey,
  thumbtackTokenStorePath,
} from './config.mjs';
import { createTokenStore } from './token-store.mjs';

/**
 * Check whether a token (from loadTokens) is expired.
 * Treats missing/null expiresAt as expired so refresh is attempted.
 */
function isExpired(tokenSet) {
  if (!tokenSet || !tokenSet.expiresAt) return true;
  // Add a 60-second grace period to avoid edge-of-expiry race conditions.
  return Date.now() >= tokenSet.expiresAt - 60_000;
}

/**
 * Refresh an expired access token via the staging OAuth token endpoint.
 * Uses HTTP Basic Auth with the staging client ID + secret.
 * Saves the rotated token set (single-use refresh token with 60s grace).
 *
 * @param {object} tokenStore - The token store instance.
 * @param {object} cfg - { stagingClientId, stagingClientSecret, stagingTokenUrl }
 * @returns {Promise<string>} The new access token.
 */
async function refreshToken(tokenStore, cfg) {
  const current = tokenStore.loadTokens();
  if (!current || !current.refreshToken) {
    throw new Error('Cannot refresh: no refresh token available');
  }

  const basicAuth = Buffer.from(`${cfg.stagingClientId}:${cfg.stagingClientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    token_type: 'REFRESH',
  });

  const response = await fetch(cfg.stagingTokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    // Capture request-id for diagnostics without leaking tokens.
    const requestId = response.headers?.get('x-request-id') || '';
    const statusText = await response.text().catch(() => '');
    console.error(`[thumbtack-api] token refresh failed: ${response.status}${requestId ? ` x-request-id: ${requestId}` : ''}`);
    throw new Error(`Token refresh failed (HTTP ${response.status})`);
  }

  const tokenData = await response.json();

  const newTokenSet = {
    accessToken: tokenData.access_token || '',
    // Refresh responses can omit an unchanged refresh token. Only refreshes
    // may retain the previous token; fresh OAuth exchanges must not do this.
    refreshToken: tokenData.refresh_token || current.refreshToken,
    tokenType: tokenData.token_type || 'Bearer',
    scope: tokenData.scope || current.scope,
    environment: cfg.environment,
    expiresIn: tokenData.expires_in,
    lastRefreshOutcome: 'success',
  };

  tokenStore.saveTokens(newTokenSet);

  return newTokenSet.accessToken;
}

/**
 * Factory for a Thumbtack API client with read primitives and gated write primitives.
 *
 * @param {object} options
 * @param {string} [options.apiBaseUrl]  - Staging API base URL (default from config).
 * @param {object} [options.tokenStore]  - Token store instance (default from config + encryptionKey).
 * @param {string} [options.stagingClientId]
 * @param {string} [options.stagingClientSecret]
 * @param {string} [options.stagingTokenUrl]
 * @param {boolean} [options.allowWrites] - Set true to enable sendMessage / postJobSignal.
 * @returns {object} The API client object.
 */
export function createThumbtackApiClient(options = {}) {
  const environment = options.environment ?? 'staging';
  if (!['staging', 'production'].includes(environment)) {
    throw new Error('Thumbtack API client: environment must be staging or production');
  }
  const useProduction = environment === 'production';
  const cfg = {
    apiBaseUrl: options.apiBaseUrl ?? (useProduction ? thumbtackApiBaseUrl : thumbtackStagingApiBaseUrl),
    stagingClientId: options.stagingClientId ?? (useProduction ? thumbtackClientId : thumbtackStagingClientId),
    stagingClientSecret: options.stagingClientSecret ?? (useProduction ? thumbtackClientSecret : thumbtackStagingClientSecret),
    stagingTokenUrl: options.stagingTokenUrl ?? (useProduction ? thumbtackOAuthTokenUrl : thumbtackStagingOAuthTokenUrl),
    environment,
    allowWrites: options.allowWrites ?? false,
  };

  const tokenStore = options.tokenStore ?? (
    thumbtackTokenEncryptionKey && (useProduction ? thumbtackProductionTokenStorePath : thumbtackTokenStorePath)
      ? createTokenStore({
        encryptionKey: thumbtackTokenEncryptionKey,
        storePath: useProduction ? thumbtackProductionTokenStorePath : thumbtackTokenStorePath,
      })
      : null
  );

  if (!cfg.apiBaseUrl) {
    throw new Error('Thumbtack API client: apiBaseUrl is required');
  }

  /** Cached access token (freshened on each getValidAccessToken call). */
  let cachedToken = null;

  /**
   * Obtain a valid (non-expired) access token.
   * Loads from the token store, refreshes if expired, and caches the result.
   * Refresh is serialized via tokenStore.withRefreshLock to prevent races.
   *
   * @returns {Promise<string>} A valid Bearer access token.
   */
  async function getValidAccessToken() {
    if (!tokenStore) {
      throw new Error('Thumbtack API client: token store not available');
    }

    const doRefresh = async () => {
      const current = tokenStore.loadTokens();
      if (!current || !current.accessToken) {
        throw new Error('No access token available. Complete OAuth flow first.');
      }

      if (!isExpired(current)) {
        cachedToken = current.accessToken;
        return cachedToken;
      }

      // Token is expired (or will expire within grace period) — refresh.
      const newToken = await refreshToken(tokenStore, cfg);
      cachedToken = newToken;
      return cachedToken;
    };

    return tokenStore.withRefreshLock(doRefresh);
  }

  /**
   * Internal HTTP request helper.
   * Builds the full URL, attaches the Bearer token without logging it,
   * and returns the parsed JSON response. On HTTP errors, logs only
   * status code and x-request-id, then throws a safe error.
   *
   * @param {string} method  - HTTP method (GET, POST, etc.)
   * @param {string} path    - API path, e.g. '/api/v4/businesses'
   * @param {object} [opts]
   * @param {object} [opts.body]   - JSON-serializable request body (POST).
   * @param {object} [opts.params] - URL query parameters.
   * @returns {Promise<any>} Parsed JSON response.
   */
  async function request(method, path, { body, params } = {}) {
    const token = await getValidAccessToken();

    const url = new URL(path, cfg.apiBaseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const fetchOpts = { method, headers };
    if (body !== undefined) {
      fetchOpts.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url.toString(), fetchOpts);
    } catch (err) {
      console.error(`[thumbtack-api] network error: ${err.message}`);
      throw new Error(`Thumbtack API request failed: ${err.message}`);
    }

    if (!response.ok) {
      const requestId = response.headers?.get('x-request-id') || '';
      const statusText = await response.text().catch(() => '');
      // Log only status + request-id — never Authorization, tokens, or body.
      console.error(
        `[thumbtack-api] HTTP ${response.status} on ${method} ${path}${requestId ? ` x-request-id: ${requestId}` : ''}`
      );
      throw new Error(`Thumbtack API error (HTTP ${response.status})`);
    }

    // For 204 No Content or empty responses, return null.
    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON response — log redacted context and return raw text.
      console.error(`[thumbtack-api] non-JSON response on ${method} ${path}`);
      return text;
    }
  }

  // ── Read primitives (always available) ──────────────────────────────────

  /** GET /api/v4/businesses */
  function getBusinesses() {
    return request('GET', '/api/v4/businesses');
  }

  /** GET /api/v4/businesses/{businessId} */
  function getBusiness(businessId) {
    return request('GET', `/api/v4/businesses/${encodeURIComponent(businessId)}`);
  }

  /** GET /api/v4/negotiations/{negotiationId} */
  function getNegotiation(negotiationId) {
    return request('GET', `/api/v4/negotiations/${encodeURIComponent(negotiationId)}`);
  }

  /** GET /api/v4/negotiations/{negotiationId}/messages */
  function getMessageHistory(negotiationId) {
    return request('GET', `/api/v4/negotiations/${encodeURIComponent(negotiationId)}/messages`);
  }

  /** GET /api/v4/businesses/{businessId}/associate-phone-numbers */
  function getBusinessAssociatePhoneNumbers(businessId) {
    return request('GET', `/api/v4/businesses/${encodeURIComponent(businessId)}/associate-phone-numbers`);
  }

  // ── Write primitives (gated behind allowWrites, default false) ──────────

  /**
   * POST /api/v4/negotiations/{negotiationId}/messages
   * Throws if allowWrites is not enabled.
   */
  async function sendMessage(negotiationId, text) {
    if (!cfg.allowWrites) {
      throw new Error('Write operations are disabled. Set allowWrites=true to enable sendMessage.');
    }
    return request('POST', `/api/v4/negotiations/${encodeURIComponent(negotiationId)}/messages`, {
      body: { text },
    });
  }

  /**
   * POST /api/v4/negotiations/{negotiationId}/job-status
   * Throws if allowWrites is not enabled.
   */
  async function postJobSignal(negotiationId, jobSignalPayload) {
    if (!cfg.allowWrites) {
      throw new Error('Write operations are disabled. Set allowWrites=true to enable postJobSignal.');
    }
    return request('POST', `/api/v4/negotiations/${encodeURIComponent(negotiationId)}/job-status`, {
      body: jobSignalPayload,
    });
  }

  return {
    getValidAccessToken,
    getBusinesses,
    getBusiness,
    getNegotiation,
    getMessageHistory,
    getBusinessAssociatePhoneNumbers,
    sendMessage,
    postJobSignal,
  };
}
