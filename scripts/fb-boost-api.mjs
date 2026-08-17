#!/usr/bin/env node
/**
 * fb-boost-api.mjs — Marketing API post boosts, ledger-gated.
 *
 * Primary path for weekly boosts (replaces Playwright Boost UI). Every dollar
 * still passes through fb-boost-ledger.mjs (eligible → reserve → publish|fail).
 *
 * Commands:
 *   status                 Config readiness + ledger snapshot (JSON)
 *   run                    Full pipeline (default). Use --dry-run to plan only.
 *   resolve-post           Find live Graph post for the current eligible pick
 *
 * Flags:
 *   --dry-run              Never reserve, never create ads, never notify spend
 *   --force-post ID        Skip Graph matching; use this post/reel id
 *   --week YYYY-MM-DD      Override schedule week
 *   --notify-human         SMS when eligible fails closed on human-review reasons
 *
 * Live spend requires ALL of:
 *   FB_BOOST_API=1
 *   FB_AD_ACCOUNT_ID=act_…
 *   FB_ADS_ACCESS_TOKEN (or page token with ads_management)
 *   FB_PAGE_ID
 *
 * Wire-in: mav-bridge daily tick after FB reconcile.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildBoostPlan,
  createGraphClient,
  createOrganicBoost,
  DEFAULT_INTEREST_QUERIES,
  EXCLUDE_INTEREST_QUERIES,
  parseAgesFromTargeting,
  readBoostConfig,
  resolveInterestIds,
  resolveLivePost,
  captionMatchTokens,
} from './lib/fb-boost-marketing.mjs';
import { sendHermesAlert } from './lib/hermes-alert.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_CLI = path.join(PROJECT_ROOT, 'scripts', 'fb-boost-ledger.mjs');
const SCHEDULE_PATH = process.env.FB_SCHEDULE_PATH
  || path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const AUDIT_PATH = path.join(PROJECT_ROOT, 'outputs', 'fb-boost-api-last.json');
const HUMAN_NOTIFY_STATE = path.join(PROJECT_ROOT, 'state', 'fb-boost-human-notify.json');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args['dry-run'] = true;
    else if (argv[i] === '--notify-human') args['notify-human'] = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

async function ledger(cmd, extraArgs = []) {
  const args = [LEDGER_CLI, cmd, ...extraArgs];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      windowsHide: true,
      encoding: 'utf8',
      env: process.env,
    });
    const text = (stdout || '').trim();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text ok */ }
    return { ok: true, stdout: text, stderr: (stderr || '').trim(), json, exitCode: 0 };
  } catch (e) {
    const stdout = (e.stdout || '').toString().trim();
    const stderr = (e.stderr || '').toString().trim();
    let json = null;
    try { json = stdout ? JSON.parse(stdout) : null; } catch { /* ignore */ }
    return {
      ok: false,
      stdout,
      stderr,
      json,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      error: e.message,
    };
  }
}

function writeAudit(payload) {
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_PATH, `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`);
}

function scheduleBlockForPick(pick) {
  if (!fs.existsSync(SCHEDULE_PATH) || !pick) return '';
  const text = fs.readFileSync(SCHEDULE_PATH, 'utf8');
  const dayNum = String(pick.key || '').match(/^day(\d+)/i)?.[1];
  if (!dayNum) return '';
  const blocks = text.split(/\n(?=## DAY \d)/);
  return blocks.find((b) => new RegExp(`\\*\\*DAY:\\*\\*\\s*${dayNum}\\b`).test(b) || b.startsWith(`## DAY ${dayNum}`)) || '';
}

function targetingTextForPick(pick) {
  const block = scheduleBlockForPick(pick);
  const m = block.match(/\*{0,2}BOOST_TARGETING:\*{0,2}\s*(.+)/i);
  return m?.[1]?.trim() || '';
}

function shouldNotifyHuman(reason) {
  return /human review required/i.test(reason || '');
}

function humanNotifyAlreadySent(week) {
  try {
    if (!fs.existsSync(HUMAN_NOTIFY_STATE)) return false;
    const st = JSON.parse(fs.readFileSync(HUMAN_NOTIFY_STATE, 'utf8'));
    return st.week === week && st.sent === true;
  } catch {
    return false;
  }
}

function markHumanNotifySent(week) {
  fs.mkdirSync(path.dirname(HUMAN_NOTIFY_STATE), { recursive: true });
  fs.writeFileSync(HUMAN_NOTIFY_STATE, `${JSON.stringify({ week, sent: true, at: new Date().toISOString() }, null, 2)}\n`);
}

async function cmdStatus(args) {
  const cfg = readBoostConfig(process.env);
  const status = await ledger('status', args.week ? ['--week', args.week] : []);
  const eligible = await ledger('eligible', args.week ? ['--week', args.week] : []);
  const out = {
    config: {
      ready: cfg.ready,
      enabled: cfg.enabled,
      missing: cfg.missing,
      adAccountId: cfg.adAccountId || null,
      pageId: cfg.pageId || null,
      apiVersion: cfg.apiVersion,
      hasAdsToken: Boolean(process.env.FB_ADS_ACCESS_TOKEN),
      hasPageToken: Boolean(process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN),
      campaignId: cfg.campaignId,
    },
    ledger: status.json || { raw: status.stdout, error: status.stderr },
    eligible: eligible.json || { raw: eligible.stdout },
  };
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

async function cmdResolvePost(args) {
  const cfg = readBoostConfig(process.env);
  if (!cfg.pageToken || !cfg.pageId) {
    console.log(JSON.stringify({ ok: false, reason: 'missing page token or FB_PAGE_ID' }));
    return 1;
  }
  const eligible = await ledger('eligible', args.week ? ['--week', args.week] : []);
  const pick = eligible.json?.pick;
  if (!eligible.json?.eligible || !pick) {
    console.log(JSON.stringify({ ok: false, reason: 'nothing eligible', eligible: eligible.json }));
    return 0;
  }
  const pageClient = createGraphClient({ token: cfg.pageToken, apiVersion: cfg.apiVersion });
  const block = scheduleBlockForPick(pick);
  const tokens = captionMatchTokens(pick, block);
  const resolved = await resolveLivePost(pageClient, {
    pageId: cfg.pageId,
    pickDate: pick.date,
    tokens,
    forcePostId: args['force-post'] || null,
  });
  console.log(JSON.stringify({ pick, tokens, ...resolved }, null, 2));
  return resolved.ok ? 0 : 1;
}

async function cmdRun(args) {
  const dryRun = Boolean(args['dry-run']);
  const cfg = readBoostConfig(process.env);
  const weekArgs = args.week ? ['--week', args.week] : [];

  const eligibleRes = await ledger('eligible', weekArgs);
  const eligible = eligibleRes.json;
  if (!eligible) {
    const out = { ok: false, stage: 'eligible', error: 'ledger eligible returned non-JSON', raw: eligibleRes.stdout };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  if (!eligible.eligible) {
    const out = { ok: true, stage: 'eligible', eligible: false, reason: eligible.reason, week: eligible.week };
    if ((args['notify-human'] || !dryRun) && shouldNotifyHuman(eligible.reason) && eligible.week) {
      if (!humanNotifyAlreadySent(eligible.week) && !dryRun) {
        try {
          await sendHermesAlert(`[FB Boost] Schedule needs human call for week ${eligible.week}: ${eligible.reason}`);
          markHumanNotifySent(eligible.week);
          out.notified = true;
        } catch (e) {
          out.notify_error = e.message;
        }
      } else {
        out.notified = false;
        out.notify_skipped = humanNotifyAlreadySent(eligible.week) ? 'already_sent' : 'dry_run';
      }
    }
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  const pick = eligible.pick;
  const week = eligible.week;

  if (!cfg.token || !cfg.pageId) {
    const out = { ok: false, stage: 'config', reason: 'missing FB_PAGE_ID or access token', pick, week };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  // Live spend hard gates — exit 0 so mav-bridge does not fault-alert while
  // credentials are still being wired. JSON stage=config is the signal.
  if (!dryRun && !cfg.enabled) {
    const out = {
      ok: true,
      stage: 'config',
      boost_applied: false,
      reason: 'FB_BOOST_API is not enabled (set FB_BOOST_API=1 for live spend)',
      pick,
      week,
      config_ready: cfg.ready,
      missing: cfg.missing,
    };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (!dryRun && !cfg.ready) {
    const out = {
      ok: true,
      stage: 'config',
      boost_applied: false,
      reason: `missing Marketing API config: ${cfg.missing.join(', ')}`,
      pick,
      week,
    };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  const client = createGraphClient({ token: cfg.token, apiVersion: cfg.apiVersion });
  // Page reads use the Page token; campaign/ad-set/creative/ad writes use the ads token.
  const pageClient = createGraphClient({ token: cfg.pageToken, apiVersion: cfg.apiVersion });
  const block = scheduleBlockForPick(pick);
  const tokens = captionMatchTokens(pick, block);
  const targetingText = targetingTextForPick(pick);
  const ages = parseAgesFromTargeting(targetingText, cfg.defaultAges);

  let resolved;
  try {
    resolved = await resolveLivePost(pageClient, {
      pageId: cfg.pageId,
      pickDate: pick.date,
      tokens,
      forcePostId: args['force-post'] || null,
    });
  } catch (e) {
    const out = { ok: false, stage: 'resolve', error: e.message, pick, week };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  if (!resolved.ok) {
    // Post not live yet — quiet exit (tomorrow's run retries). Escalate only if post date is stale.
    const ageDays = (Date.now() - new Date(`${pick.date}T12:00:00`).getTime()) / 86_400_000;
    const out = {
      ok: true,
      stage: 'resolve',
      eligible: true,
      boost_applied: false,
      reason: resolved.reason,
      pick,
      week,
      escalate: ageDays >= 1,
      candidates: resolved.candidates || [],
    };
    if (out.escalate && !dryRun) {
      try {
        await sendHermesAlert(`[FB Boost] Eligible ${pick.key} but post not live (date ${pick.date}): ${resolved.reason}`);
        out.notified = true;
      } catch (e) {
        out.notify_error = e.message;
      }
    }
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  // Confirm object still exists
  try {
    await pageClient.getObject(resolved.post_id, 'id');
  } catch (e) {
    const out = { ok: false, stage: 'verify', error: e.message, post_id: resolved.post_id, pick, week };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  let interestIds = [];
  let excludeInterestIds = [];
  if (!dryRun && cfg.ready) {
    interestIds = await resolveInterestIds(client, DEFAULT_INTEREST_QUERIES);
    excludeInterestIds = await resolveInterestIds(client, EXCLUDE_INTEREST_QUERIES);
  }

  const plan = buildBoostPlan({
    week,
    pick,
    pageId: cfg.pageId,
    postId: resolved.post_id,
    ages,
    interestIds,
    excludeInterestIds,
    campaignId: cfg.campaignId,
    lat: cfg.lat,
    lng: cfg.lng,
    radiusMi: cfg.radiusMi,
  });

  if (dryRun) {
    const out = {
      ok: true,
      stage: 'dry-run',
      dry_run: true,
      week,
      pick,
      post_id: resolved.post_id,
      permalink: resolved.post?.permalink_url || null,
      resolve_score: resolved.score,
      plan: {
        nameBase: plan.nameBase,
        object_story_id: plan.object_story_id,
        daily_budget_minor: plan.daily_budget_minor,
        start_time: plan.start_time,
        end_time: plan.end_time,
        ages,
        targeting_geo: plan.targeting.geo_locations,
        interest_ids: interestIds,
        exclude_interest_ids: excludeInterestIds,
        reuse_campaign_id: plan.reuse_campaign_id,
      },
      config: { ready: cfg.ready, enabled: cfg.enabled, missing: cfg.missing, adAccountId: cfg.adAccountId },
    };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  // ── Money gate: reserve BEFORE any ad create ──
  const reserve = await ledger('reserve', [
    '--key', pick.key,
    '--post', resolved.post_id,
    '--daily', String(pick.daily),
    '--days', String(pick.days),
    ...weekArgs,
  ]);
  if (!reserve.ok) {
    const out = {
      ok: false,
      stage: 'reserve',
      refused: true,
      detail: reserve.stderr || reserve.stdout || reserve.error,
      pick,
      week,
      post_id: resolved.post_id,
    };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  let created;
  try {
    created = await createOrganicBoost(client, {
      adAccountId: cfg.adAccountId,
      pageId: cfg.pageId,
      plan,
      status: 'ACTIVE',
    });
  } catch (e) {
    const fail = await ledger('fail', [
      '--key', pick.key,
      '--note', `Marketing API error: ${e.message}`.slice(0, 300),
      ...weekArgs,
    ]);
    let notified = false;
    try {
      await sendHermesAlert(`[FB Boost] NOT applied ${pick.key}: Marketing API error — ${e.message}`.slice(0, 400));
      notified = true;
    } catch { /* non-fatal */ }
    const out = {
      ok: false,
      stage: 'marketing_api',
      error: e.message,
      graph: e.graph || null,
      pick,
      week,
      post_id: resolved.post_id,
      ledger_fail: fail.ok,
      notified,
    };
    writeAudit(out);
    console.log(JSON.stringify(out, null, 2));
    return 1;
  }

  const publish = await ledger('publish', ['--key', pick.key, ...weekArgs]);
  const statusAfter = await ledger('status', weekArgs);
  const remaining = statusAfter.json?.remaining;
  const msg = `[FB Boost] Published ${pick.key}: $${pick.daily}/day × ${pick.days}d = $${pick.total}. Ad ${created.ad_id}. Week ${week} remaining: $${remaining ?? '?'}.`;
  let notified = false;
  try {
    await sendHermesAlert(msg);
    notified = true;
  } catch (e) {
    // publish already happened — still report notify failure
    writeAudit({
      ok: true,
      stage: 'publish',
      boost_applied: true,
      created,
      pick,
      week,
      post_id: resolved.post_id,
      publish: publish.json,
      notified: false,
      notify_error: e.message,
    });
    console.log(JSON.stringify({
      ok: true,
      boost_applied: true,
      created,
      notified: false,
      notify_error: e.message,
      pick,
      week,
      post_id: resolved.post_id,
    }, null, 2));
    return 0;
  }

  const out = {
    ok: true,
    stage: 'publish',
    boost_applied: true,
    created,
    pick,
    week,
    post_id: resolved.post_id,
    object_story_id: plan.object_story_id,
    publish: publish.json,
    remaining,
    notified,
  };
  writeAudit(out);
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'run';

let code = 0;
try {
  if (cmd === 'status') code = await cmdStatus(args);
  else if (cmd === 'resolve-post') code = await cmdResolvePost(args);
  else if (cmd === 'run') code = await cmdRun(args);
  else {
    console.error('Usage: fb-boost-api.mjs status|run|resolve-post [--dry-run] [--force-post ID] [--week YYYY-MM-DD]');
    code = 1;
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 4) }));
  code = 1;
}
process.exit(code);
