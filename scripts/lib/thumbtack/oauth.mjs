// Staging OAuth boundary for Thumbtack Partner API.
// Provides start (redirect to Thumbtack) and callback (code exchange) handlers
// with cryptographic state validation, single-use enforcement, and encrypted token persistence.
import crypto from 'node:crypto';

import {
  thumbtackClientId,
  thumbtackClientSecret,
  thumbtackOAuthAuthUrl,
  thumbtackOAuthTokenUrl,
  thumbtackScopes,
  thumbtackProductionTokenStorePath,
  thumbtackStagingClientId,
  thumbtackStagingClientSecret,
  thumbtackStagingOAuthAuthUrl,
  thumbtackStagingOAuthTokenUrl,
  thumbtackStagingScopes,
  thumbtackTokenEncryptionKey,
  thumbtackTokenStorePath,
  thumbtackOAuthRedirectUri,
  thumbtackStagingOAuthRedirectUri,
} from './config.mjs';
import { send } from './http.mjs';
import { createTokenStore } from './token-store.mjs';

const STATE_TTL = 5 * 60 * 1000; // 5 minutes

// In-memory state store: Map<state, { state, createdAt, used }>
const pendingStates = new Map();

// Periodic cleanup of expired states (lazy — each interval sweeps stale entries).
let cleanupTimer = null;
function ensureCleanup() {
  if (cleanupTimer) return;
  if (typeof setInterval !== 'undefined') {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of pendingStates.entries()) {
        if (now - record.createdAt > STATE_TTL) {
          pendingStates.delete(key);
        }
      }
    }, 60_000);
    // Allow Node.js to exit even if this interval is still running.
    if (cleanupTimer && typeof cleanupTimer === 'object' && cleanupTimer.unref) {
      cleanupTimer.unref();
    }
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeErrorHtml(message) {
  return `<!DOCTYPE html><html lang="en"><head><title>OAuth Error</title><meta charset="utf-8"></head><body><h1>Authorization Error</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function safeSuccessHtml(environment) {
  return `<!DOCTYPE html><html lang="en"><head><title>OAuth Complete</title><meta charset="utf-8"></head><body><h1>Authorization Successful</h1><p>Thumbtack ${escapeHtml(environment)} OAuth flow completed. You can close this window and return to the application.</p></body></html>`;
}

function isValidScope(scope) {
  return typeof scope === 'string'
    && scope.trim().length > 0
    && scope.trim().split(/\s+/).every((entry) => /^[A-Za-z0-9:_./-]+$/.test(entry));
}

/**
 * Factory for staging OAuth handlers. Accepts injected config for testability.
 *
 * @param {object} options
 * @param {string} [options.stagingClientId]
 * @param {string} [options.stagingClientSecret]
 * @param {string} [options.stagingAuthUrl]
 * @param {string} [options.stagingTokenUrl]
 * @param {string} [options.redirectUri]
 * @param {string} [options.scope]
 * @param {string} [options.encryptionKey]
 * @param {string} [options.tokenStorePath]
 * @param {boolean} [options.isConfigured] - Override the configured check.
 * @returns {{ handleStagingStart: Function, handleStagingCallback: Function }}
 */
export function createStagingOAuthHandlers(options = {}) {
  const cfg = {
    stagingClientId: options.stagingClientId ?? thumbtackStagingClientId,
    stagingClientSecret: options.stagingClientSecret ?? thumbtackStagingClientSecret,
    stagingAuthUrl: options.stagingAuthUrl ?? thumbtackStagingOAuthAuthUrl,
    stagingTokenUrl: options.stagingTokenUrl ?? thumbtackStagingOAuthTokenUrl,
    redirectUri: options.redirectUri ?? thumbtackStagingOAuthRedirectUri,
    scope: options.scope ?? thumbtackStagingScopes,
    encryptionKey: options.encryptionKey ?? thumbtackTokenEncryptionKey,
    tokenStorePath: options.tokenStorePath ?? thumbtackTokenStorePath,
    environment: options.environment ?? 'staging',
  };

  const configurationError = !cfg.stagingClientId || !cfg.stagingClientSecret
    || !cfg.stagingAuthUrl || !cfg.stagingTokenUrl
    || !isValidScope(cfg.scope)
    || !cfg.encryptionKey || !cfg.tokenStorePath;
  const isConfigured = options.isConfigured !== undefined
    ? options.isConfigured && !configurationError
    : !configurationError;

  let tokenStore = null;
  function getStore() {
    if (!tokenStore && cfg.encryptionKey && cfg.tokenStorePath) {
      tokenStore = createTokenStore({ encryptionKey: cfg.encryptionKey, storePath: cfg.tokenStorePath });
    }
    return tokenStore;
  }

  ensureCleanup();

  /**
   * GET /api/integrations/thumbtack/oauth/staging/start
   * Generates a cryptographic state, stores it in-memory with TTL, and
   * redirects the user to the Thumbtack staging authorization URL.
   */
  function handleStagingStart(req, res) {
    if (!isConfigured) {
      send(res, 503, `Thumbtack ${cfg.environment} OAuth not configured. Missing environment variables.\n`, 'text/plain; charset=utf-8');
      return;
    }

    const state = crypto.randomBytes(32).toString('hex');
    pendingStates.set(state, { state, createdAt: Date.now(), used: false });

    const params = new URLSearchParams({
      client_id: cfg.stagingClientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: cfg.scope,
      state,
      audience: 'urn:partner-api',
    });

    const location = `${cfg.stagingAuthUrl}?${params.toString()}`;
    res.writeHead(302, { Location: location });
    res.end();
  }

  /**
   * GET /api/integrations/thumbtack/oauth/staging/callback
   * Validates state, exchanges the authorization code, persists tokens,
   * and returns a safe HTML page (no secrets exposed).
   */
  async function handleStagingCallback(req, res) {
    if (!isConfigured) {
      send(res, 503, `Thumbtack ${cfg.environment} OAuth not configured.\n`, 'text/plain; charset=utf-8');
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryParams = url.searchParams;

    // --- Step 1: Check for provider error (user denied consent, etc.) ---
    const providerError = queryParams.get('error');
    if (providerError) {
      const stateToDelete = queryParams.get('state');
      if (stateToDelete) pendingStates.delete(stateToDelete);
      send(res, 400, safeErrorHtml('The authorization request was denied or encountered an error.'), 'text/html; charset=utf-8');
      return;
    }

    // --- Step 2: Validate state ---
    const state = queryParams.get('state');
    if (!state) {
      send(res, 400, safeErrorHtml('Missing state parameter. Please restart the OAuth flow.'), 'text/html; charset=utf-8');
      return;
    }

    const stateRecord = pendingStates.get(state);
    if (!stateRecord) {
      send(res, 400, safeErrorHtml('Invalid state parameter. Please restart the OAuth flow.'), 'text/html; charset=utf-8');
      return;
    }

    // Check expiry (lazy cleanup — also clean this entry)
    if (Date.now() - stateRecord.createdAt > STATE_TTL) {
      pendingStates.delete(state);
      send(res, 400, safeErrorHtml('State parameter has expired. Please restart the OAuth flow.'), 'text/html; charset=utf-8');
      return;
    }

    // Single-use check
    if (stateRecord.used) {
      send(res, 400, safeErrorHtml('State parameter has already been used. Please restart the OAuth flow.'), 'text/html; charset=utf-8');
      return;
    }

    // --- Step 3: Check for authorization code ---
    const code = queryParams.get('code');
    if (!code) {
      stateRecord.used = true;
      send(res, 400, safeErrorHtml('Missing authorization code. Please restart the OAuth flow.'), 'text/html; charset=utf-8');
      return;
    }

    // --- Step 4: Mark state as used (single-use enforcement) ---
    stateRecord.used = true;

    // --- Step 5: Exchange code for token ---
    try {
      const basicAuth = Buffer.from(`${cfg.stagingClientId}:${cfg.stagingClientSecret}`).toString('base64');
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
      });

      const tokenResponse = await fetch(cfg.stagingTokenUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      });

      if (!tokenResponse.ok) {
        await tokenResponse.text().catch(() => {});
        console.error(`[thumbtack-oauth] token exchange failed: ${tokenResponse.status}`);
        send(res, 502, safeErrorHtml('Failed to exchange authorization code. Please try again.'), 'text/html; charset=utf-8');
        return;
      }

      const tokenData = await tokenResponse.json();
      if (!tokenData.access_token) {
        console.error('[thumbtack-oauth] token exchange response missing access token');
        send(res, 502, safeErrorHtml('Failed to store authorization tokens. Please try again.'), 'text/html; charset=utf-8');
        return;
      }

      // --- Step 6: Persist tokens ---
      const store = getStore();
      if (!store) {
        send(res, 503, `Thumbtack ${cfg.environment} OAuth not configured.\n`, 'text/plain; charset=utf-8');
        return;
      }
      store.saveTokens({
        accessToken: tokenData.access_token,
        // A fresh authorization-code exchange must not inherit a prior refresh token.
        refreshToken: tokenData.refresh_token || '',
        tokenType: tokenData.token_type || 'Bearer',
        scope: tokenData.scope || cfg.scope,
        environment: cfg.environment,
        expiresIn: tokenData.expires_in,
        lastRefreshOutcome: 'oauth-success',
      });
      const storedTokens = store.loadTokens();
      if (!storedTokens || storedTokens.accessToken !== tokenData.access_token
        || storedTokens.refreshToken !== (tokenData.refresh_token || '')) {
        throw new Error('token persistence verification failed');
      }

      pendingStates.delete(state);

      send(res, 200, safeSuccessHtml(cfg.environment), 'text/html; charset=utf-8');
    } catch (err) {
      console.error(`[thumbtack-oauth] token exchange error: ${err.message}`);
      send(res, 502, safeErrorHtml('An error occurred during token exchange. Please try again.'), 'text/html; charset=utf-8');
    }
  }

  return { handleStagingStart, handleStagingCallback };
}

export function createProductionOAuthHandlers(options = {}) {
  return createStagingOAuthHandlers({
    stagingClientId: options.clientId ?? thumbtackClientId,
    stagingClientSecret: options.clientSecret ?? thumbtackClientSecret,
    stagingAuthUrl: options.authUrl ?? thumbtackOAuthAuthUrl,
    stagingTokenUrl: options.tokenUrl ?? thumbtackOAuthTokenUrl,
    redirectUri: options.redirectUri ?? thumbtackOAuthRedirectUri,
    scope: options.scope ?? thumbtackScopes,
    encryptionKey: options.encryptionKey ?? thumbtackTokenEncryptionKey,
    tokenStorePath: options.tokenStorePath ?? thumbtackProductionTokenStorePath,
    environment: 'production',
    isConfigured: options.isConfigured,
  });
}

// Default singleton handlers (pull from process.env via config module).
const defaultHandlers = createStagingOAuthHandlers();
export const handleStagingStart = defaultHandlers.handleStagingStart;
export const handleStagingCallback = defaultHandlers.handleStagingCallback;
const productionHandlers = createProductionOAuthHandlers();
export const handleProductionStart = productionHandlers.handleStagingStart;
export const handleProductionCallback = productionHandlers.handleStagingCallback;
