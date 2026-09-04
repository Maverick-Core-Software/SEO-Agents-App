#!/usr/bin/env node
// Read-only inventory of Thumbtack Partner API webhooks. Never prints tokens.
import { thumbtackApiBaseUrl } from './config.mjs';
import { createThumbtackApiClient } from './api.mjs';

const TARGET = 'https://cmb-workbench.tailf72e3f.ts.net/api/webhooks/thumbtack';

function summarize(hook) {
  return {
    webhookID: hook.webhookID,
    webhookURL: hook.webhookURL,
    enabled: hook.enabled,
    authType: hook.authType,
    eventTypes: hook.eventTypes,
    businessID: hook.businessID || null,
    userID: hook.userID || null,
    matchesTarget: hook.webhookURL === TARGET,
  };
}

async function apiGet(token, path) {
  const url = new URL(path, thumbtackApiBaseUrl);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: 'non-json' }; }
  return { status: res.status, requestId: res.headers.get('x-request-id') || '', body };
}

const client = createThumbtackApiClient({ environment: 'production' });
const token = await client.getValidAccessToken();
const out = { target: TARGET, businesses: null, userWebhooks: null, businessWebhooks: [] };

const businesses = await apiGet(token, '/api/v4/businesses');
out.businesses = { status: businesses.status, requestId: businesses.requestId, names: [] };
if (businesses.status === 200) {
  const rows = businesses.body?.data || businesses.body || [];
  const list = Array.isArray(rows) ? rows : [];
  out.businesses.names = list.map(b => ({
    businessID: b.businessID || b.id,
    name: b.name || b.businessName || null,
  }));
  for (const b of list) {
    const id = b.businessID || b.id;
    if (!id) continue;
    const hooks = await apiGet(token, `/api/v4/businesses/${encodeURIComponent(id)}/webhooks`);
    out.businessWebhooks.push({
      businessID: id,
      status: hooks.status,
      requestId: hooks.requestId,
      hooks: (hooks.body?.data || []).map(summarize),
    });
  }
} else {
  out.businesses.error = 'http ' + businesses.status;
}

const users = await apiGet(token, '/api/v4/users/webhooks');
out.userWebhooks = {
  status: users.status,
  requestId: users.requestId,
  hooks: (users.body?.data || []).map(summarize),
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
