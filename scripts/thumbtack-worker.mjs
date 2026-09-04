#!/usr/bin/env node
/**
 * thumbtack-worker.mjs
 * Thumbtack Partner API v4 webhook + first-touch auto-reply for Grizzly.
 * Extracted from MCC so Marketing Control / SEO-Agents-App owns the channel.
 *
 *   pm2 start scripts/thumbtack-worker.mjs --name thumbtack-worker
 *
 * Default listen: 127.0.0.1:8796. Public HTTPS is a Tailscale Funnel/Serve
 * cutover — do not start Funnel from this script.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { thumbtackListenPort } from './lib/thumbtack/config.mjs';
import {
  handleProductionCallback,
  handleProductionStart,
  handleStagingCallback,
  handleStagingStart,
} from './lib/thumbtack/oauth.mjs';
import { getThumbtackWebhookStatus, handleThumbtackWebhook } from './lib/thumbtack/webhook.mjs';

export function createThumbtackServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname === '/api/webhooks/thumbtack/health' && req.method === 'GET') {
        getThumbtackWebhookStatus(req, res);
        return;
      }
      if (url.pathname === '/api/webhooks/thumbtack' && req.method === 'POST') {
        await handleThumbtackWebhook(req, res);
        return;
      }
      if (url.pathname === '/api/integrations/thumbtack/oauth/staging/start' && req.method === 'GET') {
        await handleStagingStart(req, res);
        return;
      }
      if (url.pathname === '/api/integrations/thumbtack/oauth/staging/callback' && req.method === 'GET') {
        await handleStagingCallback(req, res);
        return;
      }
      if (url.pathname === '/api/integrations/thumbtack/oauth/start' && req.method === 'GET') {
        await handleProductionStart(req, res);
        return;
      }
      if (url.pathname === '/api/integrations/thumbtack/oauth/callback' && req.method === 'GET') {
        await handleProductionCallback(req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      console.error(`[thumbtack-worker] ${error?.message || error}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const host = process.env.THUMBTACK_BIND || '127.0.0.1';
  const server = createThumbtackServer();
  server.listen(thumbtackListenPort, host, () => {
    console.log(`[thumbtack-worker] listening on http://${host}:${thumbtackListenPort}`);
  });
}
