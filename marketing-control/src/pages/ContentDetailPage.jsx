import { useEffect, useState } from 'react';
import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { StatusChip } from '../components/StatusChip.jsx';
import { FIXTURE_DETAIL_POST } from '../fixtures/detail.js';
import { fetchPostById } from '../lib/api.js';
import { isSupabaseAvailable } from '../supabase.js';
import { postHealth } from '../lib/postHealth.js';
import { POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';

const SCAFFOLD_NOTE = 'approval scaffolding from action_queue — not in weekly_posts (Phase 2)';

const SCAFFOLD_FIELDS = [
  { key: 'steps', label: 'steps' },
  { key: 'dependencies', label: 'dependencies' },
  { key: 'verification_checklist', label: 'verification_checklist' },
  { key: 'rollback', label: 'rollback' },
  { key: 'preconditions', label: 'preconditions' },
  { key: 'acceptance_criteria', label: 'acceptance_criteria' },
  { key: 'confidence', label: 'confidence' },
  { key: 'idempotency_key', label: 'idempotency_key' },
];

const card = {
  background: '#161922',
  border: '1px solid #2a2f45',
  borderRadius: 8,
  padding: 16,
  marginTop: 16,
};

const h2 = { margin: '0 0 12px', fontSize: 16, fontWeight: 650, color: '#f1f5f9' };

function detailIdFromHash(hash) {
  return hash.startsWith('#/detail/') ? hash.slice('#/detail/'.length) : '';
}

function readSessionPost() {
  try {
    const raw = globalThis.sessionStorage?.getItem('mc.detailPost');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function dash(value) {
  if (value == null) return '—';
  if (typeof value === 'string' && value.trim() === '') return '—';
  return String(value);
}

function fieldMissing(post, key) {
  return !post || !Object.prototype.hasOwnProperty.call(post, key) || post[key] == null;
}

function listItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.checklist)) return value.checklist;
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function formatConfidence(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const label = value.label != null && value.label !== '' ? String(value.label) : '—';
    if (value.score == null || value.score === '') return label;
    return `${label} (${value.score})`;
  }
  return String(value);
}

function StatusFor({ status }) {
  const key = String(status || '').toLowerCase();
  const label = POST_STATUS_LABEL[key] || (key ? key.replace(/_/g, ' ').toUpperCase() : '—');
  const color = POST_STATUS_COLOR[key] || '#4b5563';
  return <StatusChip label={label} color={color} />;
}

function Field({ label, children }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid #2a2f45',
      }}
    >
      <div style={{ width: 168, flexShrink: 0, color: '#94a3b8', fontWeight: 600 }}>{label}</div>
      <div style={{ color: '#f1f5f9', minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

function ListValue({ items }) {
  if (!items.length) return '—';
  return (
    <ol style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((item, i) => (
        <li key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
      ))}
    </ol>
  );
}

export default function ContentDetailPage() {
  const [state, setState] = useState({ post: null, source: 'empty', loading: true });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState({ post: null, source: 'empty', loading: true });
      const id = detailIdFromHash(window.location.hash);
      let next = null;
      let nextSource = 'empty';
      if (id && isSupabaseAvailable) {
        next = await fetchPostById(id);
        nextSource = next ? 'live' : 'empty';
      } else {
        const session = readSessionPost();
        if (session) {
          next = session;
          nextSource = 'session';
        }
      }
      if (!next && !isSupabaseAvailable) {
        next = FIXTURE_DETAIL_POST;
        nextSource = 'fixture';
      }
      if (!cancelled) setState({ post: next, source: nextSource, loading: false });
    }
    load();
    window.addEventListener('hashchange', load);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', load);
    };
  }, []);

  const { post, source, loading } = state;

  if (loading) {
    return (
      <section className="page">
        <h1>Content Detail</h1>
        <p>Loading…</p>
      </section>
    );
  }

  if (!post) {
    return (
      <section className="page">
        <a className="backLink" href="#/today">← Back to This Week</a>
        <h1>Content Detail</h1>
        <p>Read-only post/action view — pick a post from Today or Calendar.</p>
      </section>
    );
  }

  const date = post.post_date || post.date;
  const headline = post.headline || post.hook;
  const photo = post.photo_file;
  const confirmPhoto = /\[CONFIRM\]/i.test(String(photo || ''));
  const health = postHealth(post);

  return (
    <section className="page">
      <a className="backLink" href="#/today">← Back to This Week</a>
      <h1>Content Detail</h1>
      <p>
        Read-only post/action view
        {source === 'live'
          ? ' — loaded live by id.'
          : source === 'session'
            ? ' — loaded from session (mc.detailPost).'
            : ' — fixture copy (no session post).'}
      </p>

      <div style={card}>
        <h2 style={h2}>Copy</h2>
        <Field label="platform">{dash(post.platform)}</Field>
        <Field label="day">{post.day == null || post.day === '' ? '—' : String(post.day)}</Field>
        <Field label="date">{dash(date)}</Field>
        <Field label="service">{dash(post.service)}</Field>
        <Field label="topic">{dash(post.topic)}</Field>
        <Field label="trend_tie">{dash(post.trend_tie)}</Field>
        <Field label="headline / hook">{dash(headline)}</Field>
        <Field label="body">
          <div style={{ whiteSpace: 'pre-wrap' }}>{dash(post.body)}</div>
        </Field>
        <Field label="caption">
          <div style={{ whiteSpace: 'pre-wrap' }}>{dash(post.caption)}</div>
        </Field>
        <Field label="cta">{dash(post.cta)}</Field>
        <Field label="hashtags">{dash(post.hashtags)}</Field>
        <Field label="photo_file">
          {dash(photo)}
          {confirmPhoto ? (
            <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>
              [CONFIRM] — owner photo verification required before publish.
            </div>
          ) : null}
        </Field>
        <Field label="type">{dash(post.type)}</Field>
        <Field label="media_status">{dash(post.media_status)}</Field>
        <Field label="status">
          <StatusFor status={post.status} />
          {health.state === 'green' || health.state === 'red' ? (
            <span style={{ marginLeft: 8, color: '#94a3b8', fontSize: 12 }}>
              health {health.state}
              {health.reason ? ` — ${health.reason}` : ''}
            </span>
          ) : null}
        </Field>
        <Field label="posted_at">{dash(post.posted_at)}</Field>
        <Field label="platform_post_id">{dash(post.platform_post_id)}</Field>
        <Field label="error">{dash(post.error)}</Field>
      </div>

      <div style={card}>
        <h2 style={h2}>Approval scaffolding</h2>
        {SCAFFOLD_FIELDS.map(({ key, label }) => {
          const missing = fieldMissing(post, key);
          let body;
          if (missing) {
            body = (
              <>
                —
                <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>{SCAFFOLD_NOTE}</div>
              </>
            );
          } else if (key === 'confidence') {
            body = formatConfidence(post[key]);
          } else if (key === 'idempotency_key' || key === 'rollback') {
            body = dash(post[key]);
          } else {
            body = <ListValue items={listItems(post[key])} />;
          }
          return (
            <Field key={key} label={label}>
              {body}
            </Field>
          );
        })}
      </div>

      <div style={card}>
        <h2 style={h2}>Run history</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['posted_at', 'platform_post_id', 'media_status', 'error'].map((col) => (
                  <th
                    key={col}
                    style={{
                      textAlign: 'left',
                      color: '#94a3b8',
                      fontWeight: 600,
                      padding: '8px 10px',
                      borderBottom: '1px solid #2a2f45',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={td}>{dash(post.posted_at)}</td>
                <td style={td}>{dash(post.platform_post_id)}</td>
                <td style={td}>{dash(post.media_status)}</td>
                <td style={td}>{dash(post.error)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <ReadOnlyButton>Approve</ReadOnlyButton>
        <ReadOnlyButton>Skip</ReadOnlyButton>
        <ReadOnlyButton>Run</ReadOnlyButton>
        <ReadOnlyButton>Retry</ReadOnlyButton>
        <ReadOnlyButton>Edit note</ReadOnlyButton>
      </div>
    </section>
  );
}

const td = {
  padding: '8px 10px',
  borderBottom: '1px solid #2a2f45',
  verticalAlign: 'top',
  color: '#f1f5f9',
};
