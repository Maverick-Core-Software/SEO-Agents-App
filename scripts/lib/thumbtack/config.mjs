import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function loadProjectEnv(envPath = path.join(PROJECT_ROOT, '.env')) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

loadProjectEnv();

const dataDir = process.env.THUMBTACK_DATA_DIR
  || path.join(PROJECT_ROOT, 'state', 'thumbtack');

export const thumbtackEventsFile = process.env.THUMBTACK_EVENTS_FILE
  || path.join(dataDir, 'events.jsonl');
export const thumbtackAutomationFile = process.env.THUMBTACK_AUTOMATION_FILE
  || path.join(dataDir, 'automation.jsonl');
export const thumbtackWebhookSecret = process.env.THUMBTACK_WEBHOOK_SECRET || '';
export const thumbtackClientId = process.env.THUMBTACK_CLIENT_ID || '';
export const thumbtackClientSecret = process.env.THUMBTACK_CLIENT_SECRET || '';
export const thumbtackStagingClientId = process.env.THUMBTACK_STAGING_CLIENT_ID || '';
export const thumbtackStagingClientSecret = process.env.THUMBTACK_STAGING_CLIENT_SECRET || '';
export const thumbtackOAuthAuthUrl = process.env.THUMBTACK_OAUTH_AUTH_URL || 'https://auth.thumbtack.com/oauth2/auth';
export const thumbtackOAuthTokenUrl = process.env.THUMBTACK_OAUTH_TOKEN_URL || 'https://auth.thumbtack.com/oauth2/token';
export const thumbtackApiBaseUrl = process.env.THUMBTACK_API_BASE_URL || 'https://api.thumbtack.com';
export const thumbtackScopes = process.env.THUMBTACK_SCOPES || '';
export const thumbtackStagingOAuthAuthUrl = process.env.THUMBTACK_STAGING_OAUTH_AUTH_URL || '';
export const thumbtackStagingOAuthTokenUrl = process.env.THUMBTACK_STAGING_OAUTH_TOKEN_URL || '';
export const thumbtackStagingApiBaseUrl = process.env.THUMBTACK_STAGING_API_BASE_URL || '';
export const thumbtackStagingScopes = process.env.THUMBTACK_STAGING_SCOPES || '';
export const thumbtackTokenEncryptionKey = process.env.THUMBTACK_TOKEN_ENCRYPTION_KEY || '';
export const thumbtackTokenStorePath = process.env.THUMBTACK_TOKEN_STORE_PATH
  || path.join(dataDir, 'staging-tokens.json');
export const thumbtackProductionTokenStorePath = process.env.THUMBTACK_PRODUCTION_TOKEN_STORE_PATH
  || path.join(dataDir, 'production-tokens.json');
export const thumbtackOAuthRedirectUri = process.env.THUMBTACK_OAUTH_REDIRECT_URI
  || 'https://carterspc.tailf72e3f.ts.net:8796/api/integrations/thumbtack/oauth/callback';
export const thumbtackStagingOAuthRedirectUri = process.env.THUMBTACK_STAGING_OAUTH_REDIRECT_URI
  || 'https://carterspc.tailf72e3f.ts.net:8796/api/integrations/thumbtack/oauth/staging/callback';
export const thumbtackAutoReplyEnabled = process.env.THUMBTACK_AUTO_REPLY_ENABLED === 'true';
export const thumbtackNativeAutoReplyDisabled = process.env.THUMBTACK_NATIVE_AUTO_REPLY_DISABLED === 'true';
export const thumbtackHcpWritesEnabled = process.env.THUMBTACK_HCP_WRITES_ENABLED === 'true';
export const thumbtackListenPort = Number.parseInt(process.env.THUMBTACK_PORT || process.env.PORT || '8796', 10);
export const thumbtackMavUrl = process.env.THUMBTACK_MAV_URL || 'http://127.0.0.1:3012/internal/thumbtack/reply';
export const thumbtackMavTimeoutMs = Number.parseInt(process.env.THUMBTACK_MAV_TIMEOUT_MS || '45000', 10);
export const thumbtackProjectRoot = PROJECT_ROOT;
export const thumbtackDataDir = dataDir;
