// Encrypted token persistence for Thumbtack staging OAuth.
// Uses AES-256-GCM via node:crypto. Token material is never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { platform } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

const isWin = platform() === 'win32';

/**
 * Derive a 32-byte key from the encryption key string using SHA-256.
 * This allows any-length key strings to become valid AES-256 keys.
 */
function deriveKey(encryptionKey) {
  return crypto.createHash('sha256').update(encryptionKey, 'utf8').digest();
}

/**
 * Encrypt a plaintext object. Returns { iv (hex), tag (hex), data (hex) }.
 */
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const payload = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/**
 * Decrypt a cipher bundle { iv, tag, data } back to an object.
 * Throws on authentication failure (wrong key or tampered data).
 */
function decrypt(key, bundle) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(bundle.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(bundle.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(bundle.data, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Create an encrypted token store for one staging principal.
 *
 * @param {object} options
 * @param {string} options.encryptionKey  - Secret key for AES-256-GCM. Required.
 * @param {string} options.storePath      - Path to the JSON file on disk.
 * @returns {object} { saveTokens, loadTokens, getRefreshLock, withRefreshLock }
 */
export function createTokenStore({ encryptionKey, storePath }) {
  if (!encryptionKey) {
    throw new Error('Token store: encryptionKey is required');
  }
  if (!storePath) {
    throw new Error('Token store: storePath is required');
  }

  const key = deriveKey(encryptionKey);

  // Promise-based mutex for serialized refresh.
  let refreshQueue = Promise.resolve();

  /**
   * Save tokens to encrypted file.
   *
   * @param {object} tokenSet - Must contain at minimum:
   *   { accessToken, refreshToken, tokenType, scope, environment, issuedAt, expiresAt }
   *   environment defaults to 'staging'.
   *   issuedAt defaults to Date.now().
   *   expiresAt is derived from expiresIn (seconds) if not provided.
   *   lastRefreshOutcome defaults to 'saved'.
   */
  function saveTokens(tokenSet) {
    // Strip secrets from the metadata record — store only audit-safe fields
    // in the outer JSON, with actual token material inside the encrypted payload.
    const payload = {
      accessToken: tokenSet.accessToken || '',
      refreshToken: tokenSet.refreshToken || '',
      tokenType: tokenSet.tokenType || 'Bearer',
      scope: tokenSet.scope || '',
    };

    const metadata = {
      environment: tokenSet.environment || 'staging',
      issuedAt: tokenSet.issuedAt || Date.now(),
      expiresAt: tokenSet.expiresAt || null,
      lastRefreshOutcome: tokenSet.lastRefreshOutcome || 'saved',
    };

    // Recalculate expiresAt if expiresIn was provided.
    if (tokenSet.expiresIn && !tokenSet.expiresAt) {
      metadata.expiresAt = Date.now() + tokenSet.expiresIn * 1000;
    }

    const encrypted = encrypt(key, payload);

    const storeData = {
      ...metadata,
      encrypted,
    };

    // Ensure directory exists.
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(storePath, JSON.stringify(storeData, null, 2), 'utf8');

    // Set restrictive permissions on POSIX; no-op on Windows.
    if (!isWin) {
      try {
        fs.chmodSync(storePath, 0o600);
      } catch {
        // Best-effort — some filesystems may not support chmod.
      }
    }
  }

  /**
   * Load and decrypt tokens from file.
   *
   * @returns {object|null} Token set with { accessToken, refreshToken, tokenType, scope, environment, issuedAt, expiresAt, lastRefreshOutcome } or null.
   */
  function loadTokens() {
    if (!fs.existsSync(storePath)) {
      return null;
    }

    let raw;
    try {
      raw = fs.readFileSync(storePath, 'utf8');
    } catch {
      return null;
    }

    let storeData;
    try {
      storeData = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!storeData.encrypted) {
      return null;
    }

    // Authentication failure (tampered or wrong key) propagates up.
    const payload = decrypt(key, storeData.encrypted);

    return {
      accessToken: payload.accessToken || '',
      refreshToken: payload.refreshToken || '',
      tokenType: payload.tokenType || 'Bearer',
      scope: payload.scope || '',
      environment: storeData.environment || 'staging',
      issuedAt: storeData.issuedAt || null,
      expiresAt: storeData.expiresAt || null,
      lastRefreshOutcome: storeData.lastRefreshOutcome || '',
    };
  }

  /**
   * Return a promise that resolves when the current refresh lock (if any)
   * is released. Allows external callers to await their turn for refresh.
   *
   * @returns {Promise<void>}
   */
  function getRefreshLock() {
    return refreshQueue;
  }

  /**
   * Execute `fn` under the serialized refresh lock. Only one call executes
   * at a time; concurrent callers queue and wait their turn.
   *
   * @param {Function} fn - Async function to run while holding the lock.
   * @returns {Promise<any>} Result of `fn`.
   */
  async function withRefreshLock(fn) {
    let release;
    const nextLock = new Promise((resolve) => { release = resolve; });
    // Chain onto the existing queue.
    const prevLock = refreshQueue;
    refreshQueue = refreshQueue.then(() => nextLock);

    // Wait for all prior holders to finish, then run.
    await prevLock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { saveTokens, loadTokens, getRefreshLock, withRefreshLock };
}
