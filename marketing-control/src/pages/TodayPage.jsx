import { useState } from 'react';
import { useMarketingData, partitionPosts } from '../lib/useMarketingData.js';
import { postHealth, healthReason } from '../lib/postHealth.js';
import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { StatusChip } from '../components/StatusChip.jsx';
import {
  chipForPost,
  cleanCopy,
  dayLabelFor,
  isRecoveryItem,
  FIXTURE_TODAY,
  FIXTURE_WEEK_START,
  FIXTURE_WEEK_END,
  FIXTURE_POSTS,
  FIXTURE_TASKS,
  FIXTURE_HEALTH,
  FIXTURE_ADAPTERS,
} from '../fixtures/week.js';

const C = {
  surface: '#161922',
  border: '#2a2f45',
  text: '#f1f5f9',
  muted: '#94a3b8',
  indigo: '#6366f1',
  red: '#ef4444',
  green: '#10b981',
  amber: '#f59e0b',
};

const ADAPTER_DOT = {
  live_ready: C.green,
  worker: C.amber,
  missing: C.red,
  error: C.red,
};

function recoveryReason(item) {
  if (item?.error) return item.error;
  const hr = healthReason(item);
  if (hr) return hr;
  const status = String(item?.status || '');
  if (status === 'needs_verification') return 'Needs verification';
  if (status === 'posting' && !item?.posted_at) return 'Stuck in posting state (no posted_at)';
  if (status === 'error') return 'Post failed';
  return status || 'Needs recovery';
}

function itemTitle(item) {
  return cleanCopy(item.service) || cleanCopy(item.hook) || item.title || item.id;
}

function postedCount(list) {
  return (list || []).filter((p) => p.status === 'posted' || p.status === 'done').length;
}

export default function TodayPage(props) {
  const data = useMarketingData();
  const [tab, setTab] = useState('facebook');

  const configured = data.configured;
  const waiting = configured && data.loading;
  const usingFixtures = !waiting && (!configured || !(data.posts && data.posts.length));

  const today = usingFixtures ? FIXTURE_TODAY : data.today;
  const weekStart = usingFixtures ? FIXTURE_WEEK_START : data.weekStart;
  const weekEnd = usingFixtures ? FIXTURE_WEEK_END : data.weekEnd;
  const posts = usingFixtures ? FIXTURE_POSTS : data.posts;
  const tasks = usingFixtures ? FIXTURE_TASKS : (data.tasks || []);
  const health = usingFixtures ? FIXTURE_HEALTH : data.health;
  const adapters = FIXTURE_ADAPTERS;

  const { facebook, gbp } = partitionPosts(posts);
  const activePosts = (tab === 'gbp' ? gbp : facebook)
    .slice()
    .sort((a, b) => String(a.post_date).localeCompare(b.post_date));

  const pendingCount = [...(posts || []), ...tasks].filter((x) => x.status === 'pending_approval').length;
  const recoveryItems = [...(posts || []), ...tasks].filter(isRecoveryItem);
  const fbPosted = postedCount(facebook);
  const gbpPosted = postedCount(gbp);
  const gbpNative = gbp.filter((p) => p.status === 'scheduled_native').length;

  if (waiting) {
    return (
      <section className="page">
        <h1>This Week</h1>
        <p>{weekStart} – {weekEnd}</p>
        <p style={{ marginTop: 12 }}>Loading this week…</p>
      </section>
    );
  }

  return (
    <section className="page">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1>This Week</h1>
        <div style={{ color: C.muted, fontSize: 13 }}>{weekStart} – {weekEnd}</div>
      </div>

      {data.error ? (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 8,
          background: '#ef444422', border: '1px solid #ef444444', color: C.red, fontSize: 13,
        }}>
          Live data unavailable — showing fixtures. {data.error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <div style={summaryCard}>
          <div style={{ color: C.amber, fontSize: 22, fontWeight: 700 }}>{pendingCount}</div>
          <div style={summaryLabel}>Pending approval</div>
        </div>
        <div style={summaryCard}>
          <div style={{ color: health?.live === 'done' ? C.green : health?.live === 'error' ? C.red : C.indigo, fontSize: 18, fontWeight: 700 }}>
            {health?.live || 'idle'}
          </div>
          <div style={summaryLabel}>Run {health?.bucket || 'incomplete'}</div>
        </div>
        <div style={{ ...summaryCard, textAlign: 'left' }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {adapters.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: 99,
                    background: ADAPTER_DOT[a.status] || C.muted,
                    display: 'inline-block',
                  }}
                />
                <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{a.label}</span>
                <span style={{ color: C.muted, fontSize: 11 }}>{a.status.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
          <div style={{ ...summaryLabel, marginTop: 8 }}>Adapter readiness</div>
        </div>
      </div>

      {recoveryItems.length > 0 ? (
        <div style={{
          marginTop: 16, background: '#ef444411', border: '1px solid #ef444433',
          borderRadius: 8, padding: '10px 14px',
        }}>
          <div style={{ color: C.red, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
            Alerts ({recoveryItems.length})
          </div>
          {recoveryItems.map((item) => (
            <div key={`alert-${item.id}`} style={{ color: C.red, fontSize: 12, marginBottom: 4 }}>
              ⚠ {item.platform ? `${item.platform} · ` : ''}{itemTitle(item)} — {recoveryReason(item)}
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ marginTop: 20 }}>
        <div style={{
          color: C.red, fontSize: 12, fontWeight: 800, letterSpacing: 1,
          textTransform: 'uppercase', marginBottom: 10,
        }}>
          Needs recovery
        </div>
        {recoveryItems.length === 0 ? (
          <p>No items need recovery.</p>
        ) : recoveryItems.map((item) => (
          <div key={`rec-${item.id}`} style={{
            background: C.surface, border: '1px solid #ef444466', borderRadius: 8,
            padding: '12px 14px', marginBottom: 8,
          }}>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
              {item.platform ? `${item.platform} · ` : ''}{itemTitle(item)}
            </div>
            <div style={{ color: C.red, fontSize: 12, margin: '6px 0 10px' }}>{recoveryReason(item)}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <ReadOnlyButton>Retry</ReadOnlyButton>
              <ReadOnlyButton>Skip</ReadOnlyButton>
              <ReadOnlyButton>Ack</ReadOnlyButton>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 20, marginBottom: 16 }}>
        {[
          { key: 'facebook', label: 'Facebook', posted: fbPosted, total: facebook.length },
          { key: 'gbp', label: 'Google Business', posted: gbpPosted, total: gbp.length, native: gbpNative },
        ].map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={{
                padding: '7px 14px', borderRadius: 6, border: '1px solid',
                borderColor: active ? C.indigo : C.border,
                background: active ? 'rgba(99, 102, 241, 0.13)' : 'transparent',
                color: active ? '#818cf8' : C.muted,
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {t.label}
              <span style={{
                background: C.border, borderRadius: 10, padding: '1px 6px',
                fontSize: 10, color: C.muted,
              }}>
                {t.native != null
                  ? `${t.posted}/${t.total} · ${t.native} native`
                  : `${t.posted}/${t.total}`}
              </span>
            </button>
          );
        })}
      </div>

      {activePosts.length === 0 ? (
        <p>No posts scheduled this week.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {activePosts.map((post) => {
            const chip = chipForPost(post, today);
            const healthRow = postHealth(post);
            const isToday = post.post_date === today;
            const rowBorder = healthRow.state === 'red'
              ? '1px solid #ef444466'
              : isToday ? '1px solid #6366f144' : `1px solid ${C.border}`;
            const rowBackground = healthRow.state === 'red' ? '#1e1518' : isToday ? '#1e2235' : C.surface;
            return (
              <div
                key={post.id}
                style={{
                  background: rowBackground, border: rowBorder, borderRadius: 7,
                  padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 42, textAlign: 'center' }}>
                  <div style={{
                    color: isToday ? '#818cf8' : C.muted, fontSize: 10, fontWeight: 700,
                    textTransform: 'uppercase',
                  }}>
                    {dayLabelFor(post.post_date)}
                  </div>
                  <div style={{ color: isToday ? C.text : C.muted, fontSize: 13, fontWeight: 600 }}>
                    {post.post_date}
                  </div>
                </div>
                <div style={{ width: 1, height: 36, background: C.border, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{
                    color: C.text, fontSize: 13, fontWeight: 600,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {cleanCopy(post.service) || cleanCopy(post.hook) || `Day ${post.day}`}
                  </div>
                  {post.hook ? (
                    <div style={{
                      color: C.muted, fontSize: 11, marginTop: 2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {cleanCopy(post.hook)}
                    </div>
                  ) : null}
                </div>
                <StatusChip label={chip.label} color={chip.color} />
                <span style={{ color: C.muted, fontSize: 11, minWidth: 72 }}>
                  {post.media_status || '—'}
                </span>
                <span style={{
                  color: healthRow.state === 'green' ? C.green : healthRow.state === 'red' ? C.red : C.muted,
                  fontSize: 11, fontWeight: 700, minWidth: 88, textAlign: 'right',
                }}>
                  {healthRow.state === 'green' ? 'green'
                    : healthRow.state === 'red' ? (healthRow.reason || 'red')
                      : 'neutral'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const summaryCard = {
  background: '#1a1d26',
  border: '1px solid #2a2f45',
  borderRadius: 8,
  padding: '12px 18px',
  flex: 1,
  minWidth: 140,
  textAlign: 'center',
};

const summaryLabel = {
  color: '#6b7280',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
  marginTop: 4,
};
