import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoInstant = z.string().min(20);

export const WeekSpecSchema = z.object({
  run_friday: isoDate,
  week_of: isoDate,
  gbp_start: isoDate,
  computed_at: isoInstant,
  gbp_dates: z.object({ 1: isoDate, 2: isoDate, 3: isoDate, 4: isoDate, 5: isoDate, 6: isoDate, 7: isoDate }),
  fb_dates: z.object({ 1: isoDate, 3: isoDate, 5: isoDate, 6: isoDate }),
});

export const ObservationSchema = z.object({
  id: z.string().min(1),
  attempt_id: z.string().min(1),
  source: z.enum(['search_console', 'facebook', 'serpapi', 'history', 'facts', 'trends']),
  scope: z.string(),
  geography: z.string().nullable(),
  period: z.object({ start: isoDate, end: isoDate }).nullable(),
  status: z.enum(['ok', 'unavailable', 'error']),
  metric: z.string().nullable(),
  value: z.unknown(),
  raw_ref: z.string().nullable(),
  retrieved_at: isoInstant,
  note: z.string().nullable(),
});

const ScoreSet = z.object({
  priority: z.number().min(0).max(1),
  demand: z.number().min(0).max(1),
  opportunity: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
  season: z.number().min(0).max(1),
  performance: z.number().min(0).max(1),
});

export const CandidateSchema = z.object({
  service_key: z.string().min(1),
  service_label: z.string().min(1),
  city: z.string().min(1),
  query_family: z.array(z.string()),
  scores: ScoreSet,
  total: z.number(),
  reasons: z.array(z.string()),
});

export const SelectionSchema = z.object({
  winner: CandidateSchema,
  ranked: z.array(CandidateSchema),
  excluded: z.array(z.object({ candidate: CandidateSchema, reason: z.string() })),
  rationale: z.string(),
  degraded: z.boolean(),
});

export const GbpItemSchema = z.object({
  day: z.number().int().min(1).max(7),
  date: isoDate,
  service: z.string().min(1),
  topic: z.string().min(1),
  trend_tie: z.string(),
  headline: z.string().min(1).max(100),
  body: z.string().min(1).max(1500),
  caption: z.string(),
  photo_file: z.string().nullable(),
  cta: z.string().min(1),
  hashtags: z.array(z.string()).min(3).max(5),
  status: z.literal('Needs approval'),
});

export const FbBoostSchema = z.object({
  decision: z.enum(['YES', 'MAYBE', 'NO']),
  daily_usd: z.number().nullable(),
  days: z.number().int().nullable(),
});

export const FbItemSchema = z.object({
  day: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(6)]),
  date: isoDate,
  type: z.enum(['slideshow', 'photo', 'carousel', 'text']),
  service: z.string().min(1),
  post_goal: z.enum(['education', 'social_proof', 'engagement', 'entertainment']),
  format: z.string(),
  hook: z.string().min(1),
  body: z.string().min(1).max(900),
  cta: z.string().min(1),
  hashtags: z.array(z.string()).max(3),
  contact: z.string(),
  photo_file: z.string().nullable(),
  video_prompt: z.literal(''),
  on_screen_text: z.string(),
  boost: FbBoostSchema,
  boost_targeting: z.string(),
});

export const WEBSITE_ACTION_TYPES = [
  'website_blog_post',
  'website_service_page_update',
  'website_faq_update',
  'website_hours_update',
  'website_contact_form_update',
  'website_gallery_update',
  'website_layout_update',
  'website_copy_update',
];

export const WebsiteActionSchema = z.object({
  type: z.enum(WEBSITE_ACTION_TYPES),
  title: z.string().min(1),
  target: z.string(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  description: z.string(),
  owner_gate: z.boolean(),
  draft: z.object({ title: z.string(), meta_description: z.string(), html: z.string() }).nullable(),
  source_ids: z.array(z.string()),
});

export const PlanTopicSchema = z.object({
  service_key: z.string().min(1),
  service_label: z.string().min(1),
  city: z.string().min(1),
  query_family: z.array(z.string()),
});

export const PlanSchema = z.object({
  attempt_id: z.string().min(1),
  week_of: isoDate,
  topic: PlanTopicSchema,
  gbp: z.array(GbpItemSchema).length(7),
  facebook: z.array(FbItemSchema).length(4),
  website_actions: z.array(WebsiteActionSchema),
  notes: z.object({
    trend_signals: z.array(z.string()),
    photo_gaps: z.array(z.string()),
    degraded: z.boolean(),
    degraded_reason: z.string().nullable(),
  }),
});

/** What the model is asked to produce: the plan minus the fields code fills in. */
export const ModelPlanSchema = PlanSchema.omit({ attempt_id: true, week_of: true }).extend({
  gbp: z.array(GbpItemSchema.omit({ date: true, status: true })).length(7),
  facebook: z.array(FbItemSchema.omit({ date: true, contact: true, video_prompt: true })).length(4),
});

export const StageSchema = z.object({
  started_at: isoInstant,
  finished_at: isoInstant.nullable(),
  status: z.enum(['running', 'ok', 'failed', 'skipped']),
  error: z.string().nullable(),
});

export const AttemptSchema = z.object({
  id: z.string().min(1),
  week_of: isoDate,
  mode: z.enum(['legacy', 'shadow', 'new', 'offline']),
  git_sha: z.string(),
  versions: z.object({ schema: z.string(), prompt: z.string(), policy: z.string() }),
  models: z.object({ generate: z.string(), fallback: z.string().nullable() }),
  started_at: isoInstant,
  finished_at: isoInstant.nullable(),
  stages: z.record(z.string(), StageSchema),
  lease_until: isoInstant.nullable(),
  budget_usd: z.number(),
  spent_usd: z.number(),
  status: z.enum(['running', 'succeeded', 'degraded', 'failed']),
  error: z.string().nullable(),
});

export const RevisionSchema = z.object({
  id: z.string().min(1),
  attempt_id: z.string().min(1),
  week_of: isoDate,
  revision: z.number().int().min(1),
  topic: PlanTopicSchema,
  selection: SelectionSchema,
  validation: z.object({ ok: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) }),
  exported_at: isoInstant.nullable(),
  projected_at: isoInstant.nullable(),
});

export const PlanItemSchema = z.object({
  id: z.string().min(1),
  revision_id: z.string().min(1),
  platform: z.enum(['gbp', 'facebook', 'website']),
  slot_date: isoDate.nullable(),
  item_type: z.string(),
  content: z.unknown(),
  media_ref: z.string().nullable(),
  idempotency_key: z.string().min(1),
  projected_ref: z.string().nullable(),
  publish_status: z.string().nullable(),
});

export const SCHEMA_VERSION = '2026-09-06.1';

/**
 * Validate without throwing. Returns { data, issues } where issues is an array of
 * { path: 'a.b[0].c', message } (empty on success).
 */
export function parseOrIssues(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data, issues: [] };
  const issues = result.error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === 'number' ? `[${p}]` : p)).join('.').replace(/\.\[/g, '['),
    message: i.message,
  }));
  return { data: null, issues };
}
