/**
 * gbp-api-auth.mjs
 * Authentication helper for Google Business Profile API operations.
 * Reads token from C:\Users\carte\gmail-multi\tokens\grizzly1.json and auto-refreshes when needed.
 */

import fs from 'node:fs';
import path from 'node:path';

const GMAIL_MULTI_DIR = 'C:/Users/carte/gmail-multi';
// GBP API calls must be billed to the project where the Business Profile APIs are
// enabled (the project you know as hermes-agent; project_id exalted-slice-502415-s0,
// number 1084301840332). The older gmail-multi credentials.json carries the right
// OAuth scope but the wrong consumer project → every GBP call returns quota=0.
// Run scripts/authorize-gbp.mjs once to mint a token under this client.
const CREDENTIALS_FILE = process.env.GBP_CLIENT_SECRET
  || path.join(GMAIL_MULTI_DIR, 'client_secret_hermes_gbp.json');
const TOKEN_FILE = process.env.GBP_TOKEN_FILE
  || path.join(GMAIL_MULTI_DIR, 'tokens', 'grizzly-gbp.json');

export async function getGbpAccessToken() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(`GBP token file not found at: ${TOKEN_FILE}. Run setup_account.py grizzly1 first.`);
  }

  const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  const now = Date.now();

  // Expiry can be stored as either `expiry_date` (epoch ms, the JS convention)
  // or `expiry` (ISO 8601 string, the Python google-auth convention used by
  // setup_account.py). Normalise both to epoch ms.
  const expiryMs = typeof tokenData.expiry_date === 'number'
    ? tokenData.expiry_date
    : tokenData.expiry ? Date.parse(tokenData.expiry) : 0;

  // Check if token is expired or expires in < 5 minutes
  if (expiryMs && expiryMs <= now + 5 * 60 * 1000) {
    if (!tokenData.refresh_token) {
      throw new Error('GBP access token expired and no refresh_token found.');
    }
    
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      throw new Error(`Credentials file missing at: ${CREDENTIALS_FILE}`);
    }

    const clientSecrets = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    const installed = clientSecrets.installed || clientSecrets.web;

    const refreshBody = new URLSearchParams({
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshBody.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to refresh GBP OAuth token: ${res.status} ${errText}`);
    }

    const newTokens = await res.json();
    tokenData.token = newTokens.access_token;
    // Write both fields so JS readers (expiry_date) and Python readers (expiry)
    // see a freshly-refreshed credential.
    tokenData.expiry_date = now + (newTokens.expires_in * 1000);
    tokenData.expiry = new Date(tokenData.expiry_date).toISOString();
    if (newTokens.refresh_token) {
      tokenData.refresh_token = newTokens.refresh_token;
    }

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), 'utf-8');
  }

  return tokenData.token;
}

export async function gbpFetch(url, options = {}) {
  const token = await getGbpAccessToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errText = await response.text();
    const error = new Error(`GBP API Error [${response.status}]: ${errText}`);
    error.status = response.status;
    error.body = errText;
    throw error;
  }
  return await response.json();
}
