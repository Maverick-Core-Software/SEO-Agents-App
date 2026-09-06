/**
 * store-supabase.mjs — the Store interface from DESIGN.md backed by the tables
 * created in supabase/migrations/003_weekly_pipeline.sql.
 *
 * Only the NEW tables are written (seo_attempts, seo_week_leases,
 * research_observations, plan_revisions, plan_items). The legacy tables are
 * read for history only. Every write goes through the service-role client the
 * caller passes in; this module never creates a client or reads .env.
 *
 * stageRevision({ revision, items }) is the atomic path (one RPC, one
 * transaction). putRevision/putItems exist to satisfy the interface but are
 * two separate writes; stage.mjs prefers stageRevision when the store has it.
 */
import { AttemptSchema, ObservationSchema, PlanItemSchema, RevisionSchema, parseOrIssues } from './schemas.mjs';

const CHUNK = 500;

function must(result, what) {
  if (result && result.error) {
    const e = new Error(`${what}: ${result.error.message || String(result.error)}`);
    e.cause = result.error;
    throw e;
  }
  return result ? result.data : null;
}

function assertValid(schema, value, what) {
  const { data, issues } = parseOrIssues(schema, value);
  if (issues.length) {
    throw new Error(`${what}: invalid (${issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')})`);
  }
  return data;
}

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── row mappers ───────────────────────────────────────────────────────────────

export function attemptToRow(a) {
  return {
    id: a.id,
    week_of: a.week_of,
    mode: a.mode,
    git_sha: a.git_sha,
    versions: a.versions,
    models: a.models,
    started_at: a.started_at,
    finished_at: a.finished_at,
    stages: a.stages,
    lease_until: a.lease_until,
    budget_usd: a.budget_usd,
    spent_usd: a.spent_usd,
    status: a.status,
    error: a.error,
  };
}

export function rowToAttempt(r) {
  if (!r) return null;
  return {
    id: r.id,
    week_of: String(r.week_of).slice(0, 10),
    mode: r.mode,
    git_sha: r.git_sha || '',
    versions: r.versions || { schema: '', prompt: '', policy: '' },
    models: r.models || { generate: '', fallback: null },
    started_at: r.started_at,
    finished_at: r.finished_at || null,
    stages: r.stages || {},
    lease_until: r.lease_until || null,
    budget_usd: Number(r.budget_usd || 0),
    spent_usd: Number(r.spent_usd || 0),
    status: r.status,
    error: r.error || null,
  };
}

export function observationToRow(o) {
  return {
    id: o.id,
    attempt_id: o.attempt_id,
    source: o.source,
    scope: o.scope,
    geography: o.geography,
    period_start: o.period ? o.period.start : null,
    period_end: o.period ? o.period.end : null,
    status: o.status,
    metric: o.metric,
    value: o.value === undefined ? null : o.value,
    raw_ref: o.raw_ref,
    retrieved_at: o.retrieved_at,
    note: o.note,
  };
}

export function revisionToRow(rev) {
  return {
    id: rev.id,
    attempt_id: rev.attempt_id,
    week_of: rev.week_of,
    revision: rev.revision,
    topic: rev.topic,
    selection: rev.selection,
    validation: rev.validation,
    exported_at: rev.exported_at,
    projected_at: rev.projected_at,
  };
}

export function rowToRevision(r) {
  if (!r) return null;
  return {
    id: r.id,
    attempt_id: r.attempt_id,
    week_of: String(r.week_of).slice(0, 10),
    revision: r.revision,
    topic: r.topic,
    selection: r.selection,
    validation: r.validation,
    exported_at: r.exported_at || null,
    projected_at: r.projected_at || null,
  };
}

export function itemToRow(item) {
  return {
    id: item.id,
    revision_id: item.revision_id,
    platform: item.platform,
    slot_date: item.slot_date,
    item_type: item.item_type,
    content: item.content === undefined ? null : item.content,
    media_ref: item.media_ref,
    idempotency_key: item.idempotency_key,
    projected_ref: item.projected_ref,
    publish_status: item.publish_status,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} client  a @supabase/supabase-js client created with the service key
 * @param {object} [opts]  { now?: () => Date }  injectable clock for tests
 */
export function createSupabaseStore(client, opts = {}) {
  const nowFn = opts.now || (() => new Date());

  return {
    kind: 'supabase',

    async createAttempt(attempt) {
      const a = assertValid(AttemptSchema, attempt, 'createAttempt');
      const data = must(await client.from('seo_attempts').insert(attemptToRow(a)).select().single(), 'seo_attempts insert');
      return rowToAttempt(data) || a;
    },

    async getAttempt(id) {
      const data = must(await client.from('seo_attempts').select('*').eq('id', id).maybeSingle(), 'seo_attempts select');
      return rowToAttempt(data);
    },

    async updateAttempt(id, patch) {
      const row = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'id') continue;
        row[k] = v;
      }
      const data = must(await client.from('seo_attempts').update(row).eq('id', id).select().single(), 'seo_attempts update');
      return rowToAttempt(data);
    },

    async acquireLease({ week_of, attempt_id, ttlMs, now }) {
      void now; // the database clock is authoritative for leases
      const ttlSeconds = Math.max(1, Math.round((ttlMs || 0) / 1000));
      const data = must(await client.rpc('acquire_week_lease', {
        p_week_of: week_of,
        p_attempt_id: attempt_id,
        p_ttl_seconds: ttlSeconds,
      }), 'acquire_week_lease');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { ok: false, holder: null, lease_until: null };
      if (row.ok) return { ok: true };
      return { ok: false, holder: row.holder, lease_until: row.lease_until };
    },

    async releaseLease({ week_of, attempt_id }) {
      const data = must(await client.rpc('release_week_lease', {
        p_week_of: week_of,
        p_attempt_id: attempt_id,
      }), 'release_week_lease');
      return Boolean(data);
    },

    async putObservations(list) {
      const rows = (list || []).map((o) => observationToRow(assertValid(ObservationSchema, o, 'putObservations')));
      let inserted = 0;
      for (const part of chunks(rows)) {
        must(await client.from('research_observations').insert(part), 'research_observations insert');
        inserted += part.length;
      }
      return inserted;
    },

    /** Non-atomic: revision only. Prefer stageRevision. */
    async putRevision(rev) {
      const r = assertValid(RevisionSchema, rev, 'putRevision');
      must(await client.rpc('stage_plan_revision', { p_revision: revisionToRow(r), p_items: [] }), 'stage_plan_revision');
      return r;
    },

    /** Non-atomic: items only (revision must exist). Prefer stageRevision. */
    async putItems(list) {
      const rows = (list || []).map((i) => itemToRow(assertValid(PlanItemSchema, i, 'putItems')));
      let inserted = 0;
      for (const part of chunks(rows)) {
        must(await client.from('plan_items').insert(part), 'plan_items insert');
        inserted += part.length;
      }
      return inserted;
    },

    /** Atomic: one RPC inserts the revision and every item in one transaction. */
    async stageRevision({ revision, items }) {
      const r = assertValid(RevisionSchema, revision, 'stageRevision.revision');
      const rows = (items || []).map((i) => itemToRow(assertValid(PlanItemSchema, { ...i, revision_id: r.id }, 'stageRevision.item')));
      const id = must(await client.rpc('stage_plan_revision', { p_revision: revisionToRow(r), p_items: rows }), 'stage_plan_revision');
      return { revision_id: id || r.id, items: rows.length };
    },

    async listRevisions(week_of) {
      const data = must(await client.from('plan_revisions').select('*').eq('week_of', week_of).order('revision', { ascending: true }), 'plan_revisions select');
      return (data || []).map(rowToRevision);
    },

    /** Read-only history from the legacy tables (same shape as collectors/history). */
    async listPublishedHistory({ weeks = 8, now } = {}) {
      const since = new Date((now || nowFn()).getTime() - weeks * 7 * 86400000).toISOString().slice(0, 10);
      const data = must(await client.from('weekly_posts')
        .select('platform, post_date, service, hook, status, platform_post_id, photo_file')
        .gte('post_date', since)
        .order('post_date', { ascending: false })
        .limit(500), 'weekly_posts select');
      return (data || []).map((p) => ({
        platform: p.platform,
        post_date: String(p.post_date).slice(0, 10),
        service: p.service || '',
        hook: p.hook || '',
        status: p.status || '',
        platform_post_id: p.platform_post_id || null,
        photo_file: p.photo_file || null,
      }));
    },
  };
}
