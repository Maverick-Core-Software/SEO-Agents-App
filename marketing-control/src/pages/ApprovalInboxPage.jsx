import { useEffect, useState } from 'react';
import { fetchPosts, fetchRuns, fetchWebsiteTasks } from '../lib/api.js';
import { addDays, chicagoToday, mondayOfWeek, sundayOfWeek } from '../lib/week.js';
import { POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';
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
];

const PRIORITY_COLOR = {
  P1: POST_STATUS_COLOR.error,
  P2: POST_STATUS_COLOR.pending_approval,
  P3: C.muted,
};

function isPendingApproval(status) {
  const s = String(status || '').toLowerCase();
  return s === 'pending_approval' || s === 'needs_approval';
}

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

function statusLabel(status) {
  const s = String(status || '');
  if (POST_STATUS_LABEL[s]) return POST_STATUS_LABEL[s];
  if (s === 'needs_approval') return POST_STATUS_LABEL.pending_approval;
  return (s || 'unknown').replace(/_/g, ' ').toUpperCase();
}

function normalizeItem(row, type) {
  return {
    id: row.id,
    type: row.type || type,
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
        <StatusChip label={statusLabel(item.status)} color={color} />
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const today = chicagoToday();
      try {
        const [runs, posts, tasks] = await Promise.all([
          fetchRuns(),
          fetchPosts(addDays(mondayOfWeek(today), -21), sundayOfWeek(addDays(today, 21))),
          fetchWebsiteTasks(),
        ]);
        if (cancelled) return;
        const live = [
          ...runs.filter((row) => isPendingApproval(row.status)).map((row) => normalizeItem(row, 'seo_run')),
          ...posts.filter((row) => isPendingApproval(row.status)).map((row) => normalizeItem(row, 'weekly_post')),
          ...tasks.filter((row) => isPendingApproval(row.status)).map((row) => normalizeItem(row, 'website_task')),
        ];
        if (live.length) {
          setItems(live);
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

  return (
    <section className="page">
      <h1>Approval Inbox</h1>
      <p style={{ marginBottom: 12 }}>
        {items.length} item{items.length === 1 ? '' : 's'} awaiting approval. Writes are disabled.
      </p>
      {source === 'fixture' ? (
        <p style={{ marginBottom: 12 }}>
          Showing fixture queue (Supabase is not configured or returned no pending_approval rows).
        </p>
      ) : null}
      {GROUPS.map((group) => {
        const rows = items.filter((item) => item.type === group.type);
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
