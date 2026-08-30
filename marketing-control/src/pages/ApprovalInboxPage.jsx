import { useEffect, useState } from 'react';
import { fetchPosts, fetchRuns, fetchWebsiteTasks } from '../lib/api.js';
import { addDays, chicagoToday, sundayOfWeek, saturdayOfWeek } from '../lib/week.js';
import { isPendingApproval, isWaitingOnOwner, POST_STATUS_COLOR, statusLabelFor } from '../lib/status.js';
import { isSupabaseAvailable } from '../supabase.js';
import { StatusChip } from '../components/StatusChip.jsx';
import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { FIXTURE_QUEUE } from '../fixtures/approval.js';

const C = {
  bg: '#0f1117',
  surface: '#161922',
  border: '#2a2f45',
  text: '#f1f5f9',
  muted: '#94a3b8',
  indigo: '#6366f1',
};

const WRITE_TITLE = 'write action — read-only slice';

const GROUPS = [
  { type: 'seo_run', label: 'SEO runs' },
  { type: 'weekly_post', label: 'Weekly posts' },
  { type: 'website_task', label: 'Website tasks' },
  { type: 'waiting_on_owner', label: 'Waiting on owner' },
];

const PRIORITY_COLOR = {
  P1: POST_STATUS_COLOR.error,
  P2: POST_STATUS_COLOR.pending_approval,
  P3: C.muted,
};

function toPriority(raw, type) {
  const v = String(raw || '').trim().toUpperCase();
  if (['P1', 'CRITICAL', 'HIGH', '1'].includes(v)) return 'P1';
  if (['P3', 'LOW', '3'].includes(v)) return 'P3';
  if (['P2', 'MEDIUM', '2'].includes(v)) return 'P2';
  return type === 'seo_run' ? 'P1' : 'P2';
}

function formatConfidence(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'object') {
    const label = value.label || value.level || '';
    const score = value.score;
    if (label && score != null && Number.isFinite(Number(score))) {
      return `${label} (${Math.round(Number(score) * 100)}%)`;
    }
    if (label) return String(label);
    if (score != null) return String(score);
  }
  return String(value);
}

function statusColor(status) {
  const s = String(status || '');
  if (POST_STATUS_COLOR[s]) return POST_STATUS_COLOR[s];
  if (s === 'needs_approval') return POST_STATUS_COLOR.pending_approval;
  return C.muted;
}

function normalizeItem(row, type) {
  return {
    id: row.id,
    run_id: row.run_id || null,
    // Queue group is the second arg. weekly_posts.type is media (video/photo/slideshow);
    // website_tasks.type is capability (blog_post/…). Never let those overwrite the group.
    type,
    kind: type === 'seo_run' ? 'run' : type === 'website_task' || type === 'waiting_on_owner' ? 'task' : 'post',
    capability: row.type && row.type !== type ? row.type : (row.capability || null),
    title:
      row.title ||
      row.hook ||
      row.service ||
      (type === 'seo_run' ? `SEO Run ${row.week_of || ''}`.trim() : `${type} ${String(row.id || '').slice(0, 8)}`),
    priority: toPriority(row.priority, type),
    risk: row.risk || 'medium',
    confidence: formatConfidence(row.confidence),
    due_date: row.due_date || row.post_date || row.week_of || null,
    media_status: row.media_status || null,
    status: row.status || '',
    error: row.error || null,
    platform: row.platform || null,
  };
}

function Field({ label, children }) {
  return (
    <div>
      <div
        style={{
          color: C.muted,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ color: C.text, fontSize: 13 }}>{children || '—'}</div>
    </div>
  );
}

function QueueCard({ item }) {
  const color = statusColor(item.status);
  return (
    <article
      data-type={item.type}
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ color: C.indigo, fontSize: 11, fontWeight: 650, textTransform: 'uppercase' }}>
          {item.type}
        </span>
        <StatusChip label={item.priority} color={PRIORITY_COLOR[item.priority] || C.muted} />
        <StatusChip label={statusLabelFor(item.status, item.kind)} color={color} />
      </div>
      <h3 style={{ margin: '0 0 10px', fontSize: 15, fontWeight: 650, color: C.text }}>{item.title}</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <Field label="priority">{item.priority}</Field>
        <Field label="risk">{item.risk}</Field>
        <Field label="confidence">{item.confidence}</Field>
        <Field label="due">{item.due_date || '—'}</Field>
        <Field label="capability">{item.capability || '—'}</Field>
        <Field label="media_status">{item.media_status || '—'}</Field>
        <Field label="status">{item.status || '—'}</Field>
        <Field label="error">{item.error || '—'}</Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <ReadOnlyButton disabled title={WRITE_TITLE}>
          Approve
        </ReadOnlyButton>
        <ReadOnlyButton disabled title={WRITE_TITLE}>
          Skip
        </ReadOnlyButton>
      </div>
    </article>
  );
}

export default function ApprovalInboxPage(props) {
  void props;
  const [items, setItems] = useState(() => FIXTURE_QUEUE.map((row) => normalizeItem(row, row.type)));
  const [source, setSource] = useState('fixture');
  const [latestRunId, setLatestRunId] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const today = chicagoToday();
      try {
        const [runs, posts, tasks] = await Promise.all([
          fetchRuns(),
          fetchPosts(addDays(sundayOfWeek(today), -21), saturdayOfWeek(addDays(today, 21))),
          fetchWebsiteTasks(),
        ]);
        if (cancelled) return;
        const isPending = (status) => isPendingApproval(status) || isWaitingOnOwner(status);
        const groupOf = (row, base) => (isWaitingOnOwner(row.status) ? 'waiting_on_owner' : base);
        const live = [
          ...runs.filter((row) => isPending(row.status)).map((row) => normalizeItem(row, groupOf(row, 'seo_run'))),
          ...posts.filter((row) => isPending(row.status)).map((row) => normalizeItem(row, groupOf(row, 'weekly_post'))),
          ...tasks.filter((row) => isPending(row.status)).map((row) => normalizeItem(row, groupOf(row, 'website_task'))),
        ];
        if (isSupabaseAvailable && live.length) {
          setItems(live);
          setLatestRunId(runs[0]?.id || null);
          setSource('live');
        } else if (isSupabaseAvailable) {
          setItems([]);
          setSource('live');
        } else {
          setItems(FIXTURE_QUEUE.map((row) => normalizeItem(row, row.type)));
          setSource('fixture');
        }
      } catch {
        if (cancelled) return;
        setItems(FIXTURE_QUEUE.map((row) => normalizeItem(row, row.type)));
        setSource('fixture');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const inDefaultView = (item) =>
    item.type === 'waiting_on_owner' ||
    (item.type === 'seo_run' ? item.id === latestRunId : item.run_id === latestRunId);
  const visible = showAll || source !== 'live' || !latestRunId ? items : items.filter(inDefaultView);

  return (
    <section className="page">
      <h1>Approval Inbox</h1>
      <p style={{ marginBottom: 12 }}>
        {visible.length} item{visible.length === 1 ? '' : 's'} awaiting approval. Writes are disabled.
      </p>
      {source === 'fixture' ? (
        <p style={{ marginBottom: 12 }}>
          Showing fixture queue (Supabase is not configured or returned no pending_approval rows).
        </p>
      ) : null}
      {source === 'live' ? (
        <label
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 12,
            color: C.text,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all pending
        </label>
      ) : null}
      {GROUPS.map((group) => {
        const rows = visible.filter((item) => item.type === group.type);
        return (
          <section key={group.type} style={{ marginBottom: 20 }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 650, color: C.text }}>
              {group.label} ({rows.length})
            </h2>
            {rows.length === 0 ? (
              <p>No items.</p>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {rows.map((item) => (
                  <QueueCard key={`${item.type}:${item.id}`} item={item} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
