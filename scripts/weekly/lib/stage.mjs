// scripts/weekly/lib/stage.mjs
// Stage one plan revision. The revision record and one item per GBP day, per
// Facebook day and per website action go to the Store — atomically through
// `store.stageRevision` when the store offers it (Supabase RPC), else
// `putRevision` then `putItems` (file store). In shadow/offline mode the
// rendered legacy Markdown and the JSON snapshots are exported to `outDir` so
// the legacy parsers and compare.mjs can read them.
//
// Nothing here writes weekly_posts or website_tasks. The only route to those
// tables is the `project` function an S7 caller passes in, and it is invoked
// solely when `mode === 'new'` and the plan passed validation.
//
// Contract: scripts/weekly/DESIGN.md, "stage".
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GenerationInvalid, ValidationFailed } from './errors.mjs';
import { SHADOW_DIR } from './paths.mjs';
import { PlanItemSchema, PlanSchema, RevisionSchema, parseOrIssues } from './schemas.mjs';

/** Every attempt mode stagePlan accepts (the AttemptSchema enum). */
export const STAGE_MODES = Object.freeze(['legacy', 'shadow', 'new', 'offline']);

/** Modes in which the legacy-shaped files are exported to `outDir`. */
export const EXPORT_MODES = Object.freeze(['shadow', 'offline']);

/** File names written to `outDir` in an export mode. */
export const EXPORT_FILES = Object.freeze({
  gbp: 'gbp_posting_schedule.md',
  facebook: 'facebook_posting_schedule.md',
  website: 'website_queue.md',
  plan: 'plan.json',
  selection: 'selection.json',
  attempt: 'attempt.json',
  summary: 'summary.md',
});

/**
 * item_type per platform. Post item types are stable per slot on purpose: the
 * idempotency key includes item_type, and a regenerated Facebook post that
 * switched from photo to carousel must still map to the same slot. Website
 * actions use their own `type` (website_blog_post, ...).
 */
export const ITEM_TYPES = Object.freeze({ gbp: 'gbp_post', facebook: 'facebook_post' });

/** Keys accepted on `rendered` for each exported Markdown file. */
const RENDERED_KEYS = Object.freeze({
  gbp: ['gbp', 'gbp_posting_schedule', 'gbpSchedule'],
  facebook: ['facebook', 'facebook_posting_schedule', 'facebookSchedule'],
  website: ['website', 'website_queue', 'websiteQueue'],
  summary: ['summary', 'plan_summary', 'planSummary'],
});

const iso = (d) => new Date(d).toISOString();
const noop = () => {};

/** `now` as a Date (an ISO string is accepted); an invalid instant is refused. */
function toDate(now, label) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new TypeError(`${label}: now must be a valid Date`);
  return at;
}
let tmpCounter = 0;

/** sha256 hex of `week_of|platform|slot_date|item_type|service` (null/undefined → empty). */
export function idempotencyKey({ week_of, platform, slot_date, item_type, service }) {
  const parts = [week_of, platform, slot_date, item_type, service].map((v) => (v == null ? '' : String(v)));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Absolute paths of every file an export mode writes under `outDir`. */
export function exportPaths(outDir = SHADOW_DIR) {
  const root = path.resolve(outDir);
  const out = {};
  for (const [key, name] of Object.entries(EXPORT_FILES)) out[key] = path.join(root, name);
  return out;
}

function summarizeIssues(issues) {
  return issues.slice(0, 5).map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
}

function assertSchema(schema, value, label) {
  const { data, issues } = parseOrIssues(schema, value);
  if (issues.length) throw new TypeError(`stagePlan: ${label} failed schema validation: ${summarizeIssues(issues)}`);
  return data;
}

function normalizeValidation(validation) {
  if (!validation || typeof validation !== 'object') {
    throw new TypeError('stagePlan: validation { ok, errors, warnings } is required');
  }
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return { ok: Boolean(validation.ok), errors: list(validation.errors), warnings: list(validation.warnings) };
}

/** Highest existing revision number for the week plus one (1 when none). */
export async function nextRevisionNumber(store, week_of) {
  const existing = (await store.listRevisions(week_of)) || [];
  const max = existing.reduce((m, r) => Math.max(m, Number(r && r.revision) || 0), 0);
  return max + 1;
}

/**
 * One PlanItem per GBP day, Facebook day and website action.
 *
 * Website actions carry no `service`, so `target || title` fills the service
 * slot of the key (two actions of one type in a week must not collide: the
 * plan_items table is unique on (revision_id, idempotency_key)). When two
 * items would still share a key, the later ones get `#2`, `#3`, ... appended to
 * the service slot in plan order, which keeps the key deterministic.
 *
 * Post item ids are `<revision_id>-<platform>-<day>`, so a plan that names the
 * same day twice cannot be staged coherently (the file store would silently
 * keep one item, Supabase would reject the primary key): it is refused with
 * GenerationInvalid naming the duplicate slots.
 */
export function buildItems(plan, revisionId) {
  if (!plan || typeof plan !== 'object') throw new TypeError('buildItems: plan is required');
  if (!revisionId) throw new TypeError('buildItems: revisionId is required');
  const duplicates = [];
  for (const platform of ['gbp', 'facebook']) {
    const days = new Set();
    (plan[platform] || []).forEach((post, index) => {
      const day = post && post.day;
      if (days.has(day)) duplicates.push({ path: `${platform}[${index}].day`, message: `duplicate ${platform} day ${day}` });
      days.add(day);
    });
  }
  if (duplicates.length) {
    throw new GenerationInvalid(`buildItems: ${duplicates.map((d) => d.message).join('; ')}`, duplicates);
  }
  const base = { revision_id: revisionId, projected_ref: null, publish_status: null };
  const seen = new Map();
  const keyFor = (fields) => {
    const first = idempotencyKey(fields);
    const count = (seen.get(first) || 0) + 1;
    seen.set(first, count);
    return count === 1 ? first : idempotencyKey({ ...fields, service: `${fields.service == null ? '' : fields.service}#${count}` });
  };
  const items = [];
  for (const post of plan.gbp || []) {
    const fields = { week_of: plan.week_of, platform: 'gbp', slot_date: post.date, item_type: ITEM_TYPES.gbp, service: post.service };
    items.push({
      ...base,
      id: `${revisionId}-gbp-${post.day}`,
      platform: 'gbp',
      slot_date: post.date,
      item_type: ITEM_TYPES.gbp,
      content: post,
      media_ref: post.photo_file == null ? null : post.photo_file,
      idempotency_key: keyFor(fields),
    });
  }
  for (const post of plan.facebook || []) {
    const fields = { week_of: plan.week_of, platform: 'facebook', slot_date: post.date, item_type: ITEM_TYPES.facebook, service: post.service };
    items.push({
      ...base,
      id: `${revisionId}-facebook-${post.day}`,
      platform: 'facebook',
      slot_date: post.date,
      item_type: ITEM_TYPES.facebook,
      content: post,
      media_ref: post.photo_file == null ? null : post.photo_file,
      idempotency_key: keyFor(fields),
    });
  }
  (plan.website_actions || []).forEach((action, index) => {
    const service = action.target || action.title || '';
    const fields = { week_of: plan.week_of, platform: 'website', slot_date: null, item_type: action.type, service };
    items.push({
      ...base,
      id: `${revisionId}-website-${index + 1}`,
      platform: 'website',
      slot_date: null,
      item_type: action.type,
      content: action,
      media_ref: null,
      idempotency_key: keyFor(fields),
    });
  });
  return items;
}

/** Build the revision record (not yet persisted). */
export function buildRevision({ attempt, plan, selection, validation, revisionNumber, exportedAt = null }) {
  return {
    id: `${attempt.id}-r${revisionNumber}`,
    attempt_id: attempt.id,
    week_of: plan.week_of,
    revision: revisionNumber,
    topic: plan.topic,
    selection,
    validation,
    exported_at: exportedAt,
    projected_at: null,
  };
}

function pickRendered(rendered, kind) {
  if (!rendered || typeof rendered !== 'object') return undefined;
  for (const key of RENDERED_KEYS[kind]) {
    if (typeof rendered[key] === 'string') return rendered[key];
  }
  return undefined;
}

/** Fallback summary when the caller did not render one. */
export function defaultSummary({ plan, selection, validation, revision, attempt }) {
  const topic = plan.topic || {};
  const gbpDates = (plan.gbp || []).map((p) => p.date);
  const lines = [
    `# Weekly plan summary — week of ${plan.week_of}`,
    '',
    `- Attempt: \`${attempt.id}\` (mode ${attempt.mode || 'unknown'})`,
    `- Revision: ${revision.revision} (\`${revision.id}\`)`,
    `- Topic: ${topic.service_label || topic.service_key || 'unknown'} in ${topic.city || 'unknown'}`,
    `- Validation: ${validation.ok ? 'ok' : 'FAILED'} — ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`,
    `- GBP posts: ${(plan.gbp || []).length}${gbpDates.length ? ` (${gbpDates[0]} to ${gbpDates[gbpDates.length - 1]})` : ''}`,
    `- Facebook posts: ${(plan.facebook || []).length}`,
    `- Website actions: ${(plan.website_actions || []).length}`,
  ];
  if (selection && selection.rationale) lines.push('', '## Selection rationale', '', String(selection.rationale));
  if (validation.errors.length) lines.push('', '## Validation errors', '', ...validation.errors.map((e) => `- ${e}`));
  if (validation.warnings.length) lines.push('', '## Validation warnings', '', ...validation.warnings.map((w) => `- ${w}`));
  return lines.join('\n') + '\n';
}

async function writeAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  // Windows can refuse to replace a file that an indexer/AV has briefly open; retry a few times.
  for (let attempt = 1; ; attempt++) {
    try { await fs.rename(tmp, filePath); return; }
    catch (e) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        await fs.rm(tmp, { force: true }).catch(noop);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}

const pretty = (obj) => JSON.stringify(obj, null, 2) + '\n';

/**
 * Write the seven export files to `outDir`. `rendered` supplies the Markdown:
 * `{ gbp, facebook, website, summary }` (aliases: gbp_posting_schedule,
 * facebook_posting_schedule, website_queue, plan_summary). gbp/facebook/website
 * are required; a missing summary is generated. Returns the paths written.
 */
export async function writeExports(outDir, { rendered, plan, selection, attempt, revision, validation }) {
  const paths = exportPaths(outDir);
  const texts = {};
  for (const kind of ['gbp', 'facebook', 'website']) {
    const text = pickRendered(rendered, kind);
    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError(`stagePlan: rendered.${kind} (${EXPORT_FILES[kind]}) is required in an export mode`);
    }
    texts[kind] = text;
  }
  texts.summary = pickRendered(rendered, 'summary') || defaultSummary({ plan, selection, validation, revision, attempt });
  await writeAtomic(paths.gbp, texts.gbp);
  await writeAtomic(paths.facebook, texts.facebook);
  await writeAtomic(paths.website, texts.website);
  await writeAtomic(paths.plan, pretty(plan));
  await writeAtomic(paths.selection, pretty(selection));
  await writeAtomic(paths.attempt, pretty(attempt));
  await writeAtomic(paths.summary, texts.summary);
  return paths;
}

/**
 * Stage a plan revision. Returns the Revision that was persisted.
 *
 * Order: validate inputs → number the revision → build revision + items and
 * check them against the schemas → (export mode) write files → store write
 * (atomic when available) → (mode 'new' with `project`) project.
 * Files are written before the store so a stored revision never claims an
 * export that did not happen; a failed store write leaves only throwaway files.
 */
export async function stagePlan({
  store, attempt, plan, selection, validation, rendered, mode, now = new Date(), outDir, project,
} = {}) {
  if (!store) throw new TypeError('stagePlan: store is required');
  if (!attempt || typeof attempt !== 'object' || !attempt.id) throw new TypeError('stagePlan: attempt with an id is required');
  const effectiveMode = mode || attempt.mode;
  if (!effectiveMode) throw new TypeError('stagePlan: mode is required');
  if (!STAGE_MODES.includes(effectiveMode)) {
    throw new TypeError(`stagePlan: unknown mode ${JSON.stringify(effectiveMode)} (expected one of ${STAGE_MODES.join(', ')})`);
  }
  const at = toDate(now, 'stagePlan');

  const parsed = parseOrIssues(PlanSchema, plan);
  if (parsed.issues.length) {
    throw new GenerationInvalid(`stagePlan: plan failed schema validation: ${summarizeIssues(parsed.issues)}`, parsed.issues);
  }
  const validPlan = parsed.data;
  if (attempt.week_of && validPlan.week_of !== attempt.week_of) {
    throw new TypeError(`stagePlan: plan.week_of ${validPlan.week_of} does not match attempt.week_of ${attempt.week_of}`);
  }
  if (validPlan.attempt_id !== attempt.id) {
    throw new TypeError(`stagePlan: plan.attempt_id ${validPlan.attempt_id} does not match attempt.id ${attempt.id}`);
  }
  const verdict = normalizeValidation(validation);
  const exportDir = EXPORT_MODES.includes(effectiveMode) ? path.resolve(outDir || SHADOW_DIR) : null;

  const revisionNumber = await nextRevisionNumber(store, validPlan.week_of);
  const revision = assertSchema(RevisionSchema, buildRevision({
    attempt, plan: validPlan, selection, validation: verdict, revisionNumber, exportedAt: exportDir ? iso(at) : null,
  }), 'revision');
  const items = buildItems(validPlan, revision.id).map((it, i) => assertSchema(PlanItemSchema, it, `item[${i}]`));

  if (exportDir) {
    await writeExports(exportDir, { rendered, plan: validPlan, selection, attempt, revision, validation: verdict });
  }

  if (typeof store.stageRevision === 'function') {
    await store.stageRevision({ revision, items });
  } else {
    await store.putRevision(revision);
    await store.putItems(items);
  }

  if (effectiveMode === 'new' && typeof project === 'function') {
    if (!verdict.ok) {
      throw new ValidationFailed('stagePlan: refusing to project a plan that failed validation', verdict.errors, verdict.warnings);
    }
    await project({ store, attempt, plan: validPlan, selection, revision, items, now: at, mode: effectiveMode });
    revision.projected_at = iso(at);
  }

  return revision;
}
