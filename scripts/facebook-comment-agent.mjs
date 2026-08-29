#!/usr/bin/env node
/**
 * facebook-comment-agent.mjs
 * Autonomous comment reply agent for Grizzly Electrical Solutions.
 *
 * Polls Facebook Graph API every N minutes for new comments on recent posts,
 * generates human-sounding replies via Grok (xAI), and posts them back.
 *
 * Run as a PM2 process alongside mav-bridge:
 *   pm2 start scripts/facebook-comment-agent.mjs --name fb-comment-agent
 *
 * Required env (or .env):
 *   FB_PAGE_ID            — numeric Facebook Page ID
 *   FB_PAGE_ACCESS_TOKEN  — long-lived Page Access Token
 *   XAI_API_KEY           — xAI API key for Grok reply generation
 * Optional env:
 *   FB_COMMENT_POLL_MS    — poll interval in ms (default 300000 = 5 min)
 *   FB_COMMENT_MAX_REPLIES — max replies per poll cycle (default 5)
 *   FB_COMMENT_MAX_POST_AGE_DAYS — ignore comments on posts older than N days (default 7)
 *   FB_GRAPH_API_VERSION  — Graph API version (default v22.0)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveCommenterName, stripUnknownNames } from './lib/comment-name-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── .env loader (same force-override pattern as facebook-poster.mjs) ──
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── Config ──
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const POLL_MS = parseInt(process.env.FB_COMMENT_POLL_MS || '300000', 10);
const MAX_REPLIES_PER_CYCLE = parseInt(process.env.FB_COMMENT_MAX_REPLIES || '5', 10);
const MAX_POST_AGE_DAYS = parseInt(process.env.FB_COMMENT_MAX_POST_AGE_DAYS || '7', 10);

const STATE_FILE = path.join(PROJECT_ROOT, 'state', 'fb-comment-replied.json');
const LOG_FILE = path.join(PROJECT_ROOT, 'outputs', 'observability.jsonl');

// ── Structured logging ──
function hopLog(source, level, message, detail) {
  const ts = new Date().toISOString();
  const line = `[fb-comment-agent][${source}][${level}] ${message}`;
  if (level === 'error') console.error(line, detail || '');
  else console.log(line);
  // Append to observability
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts, source: `fb-comment-agent:${source}`, level, message, ...(detail ? { detail } : {}) }) + '\n');
  } catch { /* never crash on log failure */ }
}

// ── State: track which comments we've replied to ──
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { hopLog('state', 'warn', `Could not load state: ${e.message}`); }
  return { replied: {}, lastPoll: null };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // Prune entries older than MAX_POST_AGE_DAYS * 3 to keep file small
    const cutoff = Date.now() - (MAX_POST_AGE_DAYS * 3 * 86400000);
    for (const [id, ts] of Object.entries(state.replied)) {
      if (ts < cutoff) delete state.replied[id];
    }
    state.lastPoll = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { hopLog('state', 'error', `Could not save state: ${e.message}`); }
}

// ── Graph API helpers ──
function isTokenError(error) {
  return error && (
    error.code === 190 ||
    /expired|invalid.*token|session.*invalid/i.test(error.message || '')
  );
}

async function graphCall(url, label) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      hopLog('graph', 'error', `${label} non-JSON response (${res.status}): ${text.slice(0, 120)}`);
      return null;
    }
    if (json.error) {
      if (isTokenError(json.error)) {
        hopLog('graph', 'error', 'TOKEN EXPIRED — regenerate FB_PAGE_ACCESS_TOKEN', json.error);
        return null;
      }
      hopLog('graph', 'error', `${label} failed: ${json.error.message}`, { code: json.error.code });
      return null;
    }
    return json;
  } catch (e) {
    hopLog('graph', 'error', `${label} network error: ${e.message}`);
    return null;
  }
}

// ── Fetch recent posts ──
async function fetchRecentPosts() {
  const since = Math.floor(Date.now() / 1000) - (MAX_POST_AGE_DAYS * 86400);
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/posts`
    + `?fields=id,created_time,message,permalink_url`
    + `&since=${since}`
    + `&limit=25`
    + `&access_token=${FB_PAGE_ACCESS_TOKEN}`;
  
  const data = await graphCall(url, 'fetch posts');
  return data?.data || [];
}

// ── Fetch comments for a post ──
async function fetchComments(postId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/comments`
    + `?fields=id,message,from{name,id},created_time,parent`
    + `&order=reverse_chronological`
    + `&limit=50`
    + `&access_token=${FB_PAGE_ACCESS_TOKEN}`;
  
  const data = await graphCall(url, `fetch comments for ${postId}`);
  return data?.data || [];
}

// ── Post a reply ──
async function postReply(commentId, message) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/comments`
    + `?access_token=${FB_PAGE_ACCESS_TOKEN}`;

  try {
    const body = new URLSearchParams({ message });
    const res = await fetch(url, { method: 'POST', body });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      hopLog('graph', 'error', `Reply non-JSON response (${res.status}): ${text.slice(0, 120)}`, { commentId });
      return null;
    }
    if (json.error) {
      hopLog('graph', 'error', `Reply failed: ${json.error.message}`, { commentId });
      return null;
    }
    return json.id;
  } catch (e) {
    hopLog('graph', 'error', `Reply network error: ${e.message}`, { commentId });
    return null;
  }
}

// ── Grok reply generation ──
// `name` is the resolved commenter name: { known, full, first }. When Facebook
// withholds `from` (the normal case for real customers) we must not hand the
// model a placeholder or ask it for a first name — it will invent one.
export async function generateReply(commentText, name, postCaption) {
  const greet = (suffix) => (name.known ? `Thanks, ${name.first}! ${suffix}` : `Thanks! ${suffix}`).trim();

  if (!XAI_API_KEY) {
    hopLog('xai', 'warn', 'No XAI_API_KEY — using fallback reply');
    return greet('We appreciate it.');
  }

  const nameRule = name.known
    ? `- The commenter's first name is "${name.first}". You may use it once, naturally. Never use any other name.`
    : `- You do NOT know who wrote this comment. Never use a name, never guess one, never invent one.
- Do not open with "Hey <name>" or any other name. Address them directly as "you", or just start the sentence.
- Any name appearing in the post caption belongs to someone else, NOT the commenter. Never reuse it.`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning',
        max_tokens: 100,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content: `You are the owner of Grizzly Electrical Solutions, a licensed residential/commercial electrician in DFW, Texas (Rowlett/Garland/Plano/Dallas). You reply to comments on your Facebook page.

RULES:
- Be warm, human, and conversational. Sound like a real person, not a bot.
- 1-2 sentences max. Never write paragraphs.
${nameRule}
- Match their energy: if they're excited, be excited back. If they ask a question, answer helpfully.
- Never use exclamation points back-to-back.
- Never say "Thank you for your comment" or "We appreciate your feedback" — that's bot language.
- Never ask them to call. Never pitch services unless they explicitly ask.
- If they ask about pricing or services, say something like "It depends on your setup — DM us a photo and I can give you a ballpark in 5 minutes."
- Keep it casual. Contractions are good. Texas-friendly but not a caricature.`,
          },
          {
            role: 'user',
            content: `Post topic: ${postCaption.slice(0, 200)}\n\n`
              + (name.known ? `Comment from ${name.full}: ` : 'Comment (author unknown): ')
              + `"${commentText}"\n\nWrite a short, natural reply:`,
          },
        ],
      }),
    });

    const json = await res.json();
    if (json.error) {
      hopLog('xai', 'error', `Grok reply gen failed: ${json.error.message}`);
      return greet('');
    }

    const reply = json.choices?.[0]?.message?.content?.trim();
    if (!reply) return name.known ? `Appreciate it, ${name.first}!` : 'Appreciate it!';

    // Safety: strip any phone numbers the model might hallucinate
    const noPhone = reply.replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '');

    // Safety: never address the customer by a name we did not actually get
    // from Graph. This is the backstop for the prompt rules above.
    const { text, stripped } = stripUnknownNames(noPhone, name.first);
    if (stripped) {
      hopLog('xai', 'warn', 'Model used a name we do not have — stripped before posting', {
        before: noPhone.slice(0, 120), after: text.slice(0, 120),
      });
    }
    return text;
  } catch (e) {
    hopLog('xai', 'error', `Grok API error: ${e.message}`);
    return greet('');
  }
}

// ── Filter: should we reply to this comment? ──
function shouldReply(comment, state, ourPageId) {
  const cid = comment.id;

  // Already replied
  if (state.replied[cid]) return false;

  // It's our own comment (page replying to itself or first-comment contact)
  if (comment.from?.id === ourPageId) return false;

  // It's a reply to another comment (nested thread — only reply to top-level)
  if (comment.parent) return false;

  // Empty or spammy
  const msg = (comment.message || '').trim();
  if (!msg || msg.length < 2) return false;
  
  // Obvious spam patterns
  if (/buy.*followers|click.*link|free.*gift|check.*profile/i.test(msg)) return false;
  
  // Only emoji/symbols — still reply (emoji engagement counts)
  // But skip if it's just a single period or similar noise
  if (/^[.\s]{1,3}$/.test(msg)) return false;

  return true;
}

// ── Build a short post context from the post message ──
function postContext(post) {
  const msg = (post.message || '').replace(/\n+/g, ' ').trim();
  return msg.slice(0, 300) || 'an electrical service post';
}

// ── Main poll cycle ──
async function poll() {
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    hopLog('config', 'error', 'FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN not set — cannot poll');
    return;
  }

  try {
    hopLog('poll', 'info', 'Starting poll cycle');
    const state = loadState();

    // Fetch recent posts
    const posts = await fetchRecentPosts();
    if (!posts.length) {
      hopLog('poll', 'info', 'No recent posts found');
      saveState(state);
      return;
    }

    hopLog('poll', 'info', `Found ${posts.length} recent posts`);

    let repliedThisCycle = 0;
    for (const post of posts) {
      if (repliedThisCycle >= MAX_REPLIES_PER_CYCLE) {
        hopLog('poll', 'info', `Hit max replies per cycle (${MAX_REPLIES_PER_CYCLE})`);
        break;
      }

      const comments = await fetchComments(post.id);
      if (!comments.length) continue;

      const context = postContext(post);
      for (const comment of comments) {
        if (repliedThisCycle >= MAX_REPLIES_PER_CYCLE) break;
        if (!shouldReply(comment, state, FB_PAGE_ID)) continue;

        const name = resolveCommenterName(comment, FB_PAGE_ID);
        hopLog('reply', 'info', `Replying to ${name.known ? name.full : '(name withheld by Graph)'}: "${(comment.message || '').slice(0, 60)}"`);

        const replyText = await generateReply(
          comment.message || '',
          name,
          context
        );

        const replyId = await postReply(comment.id, replyText);
        if (replyId) {
          state.replied[comment.id] = Date.now();
          repliedThisCycle++;
          hopLog('reply', 'info', `✓ Replied (${replyId}) → ${replyText.slice(0, 80)}`);
        }

        // Small delay between replies to avoid rate limiting
        if (repliedThisCycle < MAX_REPLIES_PER_CYCLE) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    hopLog('poll', 'info', `Cycle complete — ${repliedThisCycle} replies sent`);
    saveState(state);
  } catch (e) {
    // Never let a transient Graph/network failure kill the PM2 process.
    hopLog('poll', 'error', `Poll cycle crashed (will retry next interval): ${e.message}`);
  }
}

// ── Health check endpoint ──
function startHealthServer() {
  const port = parseInt(process.env.FB_COMMENT_AGENT_PORT || '8795', 10);
  import('node:http').then(({ createServer }) => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const state = loadState();
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          repliedCount: Object.keys(state.replied).length,
          lastPoll: state.lastPoll,
          config: {
            pollMs: POLL_MS,
            maxReplies: MAX_REPLIES_PER_CYCLE,
            maxPostAgeDays: MAX_POST_AGE_DAYS,
          },
        }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, () => {
      hopLog('health', 'info', `Health server on :${port}`);
    });
  }).catch(() => {});
}

// ── Main ──
async function main() {
  hopLog('startup', 'info', 'facebook-comment-agent starting', {
    pollMs: POLL_MS,
    maxReplies: MAX_REPLIES_PER_CYCLE,
    maxPostAgeDays: MAX_POST_AGE_DAYS,
  });

  if (!FB_PAGE_ID) {
    hopLog('startup', 'fatal', 'FB_PAGE_ID not set — add to .env');
    process.exit(1);
  }
  if (!FB_PAGE_ACCESS_TOKEN) {
    hopLog('startup', 'fatal', 'FB_PAGE_ACCESS_TOKEN not set — add to .env');
    process.exit(1);
  }
  if (!XAI_API_KEY) {
    hopLog('startup', 'warn', 'XAI_API_KEY not set — replies will use fallback text (no Grok)');
  }

  // Start health server
  try {
    startHealthServer();
  } catch (e) {
    hopLog('health', 'warn', `Health server failed: ${e.message} — continuing without`);
  }

  // Run immediately, then poll. setInterval callbacks must not throw unhandled
  // rejections or PM2 will restart-loop on transient Facebook IPv6 timeouts.
  const safePoll = () => {
    poll().catch((e) => hopLog('poll', 'error', `Unhandled poll rejection: ${e.message}`));
  };
  safePoll();
  setInterval(safePoll, POLL_MS);
  hopLog('startup', 'info', `Polling every ${POLL_MS / 1000}s`);
}

// Only auto-start when run directly (PM2 entrypoint); importing this module
// for tests/harnesses must not spin up polling or the health server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    hopLog('startup', 'fatal', `Crash: ${e.message}`, e.stack);
    process.exit(1);
  });
}
