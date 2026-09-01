import { useState } from 'react';
import { useMarketingData, partitionPosts } from '../lib/useMarketingData.js';
import { deriveAdapters } from '../lib/adapters.js';
import { postHealth } from '../lib/postHealth.js';
import {
  isPendingApproval,
  isWaitingOnOwner,
  isOnGraph,
  isAttentionItem,
  recoveryClass,
  RECOVERY_CLASS,
  ageLabel,
  ownerFor,
  nextActionFor,
} from '../lib/status.js';
import { ReadOnlyButton } from '../components/ReadOnlyButton.jsx';
import { StatusChip } from '../components/StatusChip.jsx';
import {
  chipForPost,
  cleanCopy,
  dayLabelFor,
  FIXTURE_TODAY,
  FIXTURE_WEEK_START,
  FIXTURE_WEEK_END,
  FIXTURE_POSTS,
  FIXTURE_TASKS,
  FIXTURE_HEALTH,
  FIXTURE_ADAPTERS,
  FIXTURE_PRIOR_RECOVERY,
} from '../fixtures/week.js';

const C = {
  text: '#f1f5f9',
  muted: '#94a3b8',
  red: '#ef4444',
  green: '#10b981',
  amber: '#f59e0b',
  indigo: '#6366f1',
};

const ADAPTER_DOT = {
  live_ready: C.green,
  worker: C.amber,
  missing: C.red,
  error: C.red,
};

const CLASS_SECTIONS = [
  { cls: RECOVERY_CLASS.execution, title: 'Needs recovery', color: C.red, border: '#ef444466', accent: '●' },
  { cls: RECOVERY_CLASS.verification, title: 'Needs verification', color: C.amber, border: '#f59e0b55', accent: '◆' },
  { cls: RECOVERY_CLASS.owner, title: 'Waiting on owner', color: C.amber, border: '#f59e0b55', accent: '◈' },
];

function recoveryReason(item) {
  if (item?.error) return item.error;
  const status = String(item?.status || '');
  if (status === 'waiting_on_owner') return 'Waiting on owner';
  if (status === 'needs_verification') return 'Needs verification';
  if (status === 'scheduled_native') return 'Queued for 9am tick — still not live';
  if (status === 'scheduled') return 'Fallback schedule — not yet published';
  if (status === 'skipped') return item?.error || 'Skipped';
  if (status === 'posting' && !item?.posted_at) return 'Stuck in posting state (no posted_at)';
  if (status === 'error') return item?.platform ? 'Post failed' : 'Task failed';
  return status || 'Needs recovery';
}

function openPost(post) {
  try {
    sessionStorage.setItem('mc.detailPost', JSON.stringify(post));
  } catch {
    // private mode / quota — still navigate
  }
  window.location.hash = `#/detail/${post.id}`;
}

function openItem(item) {
  if (item?.platform) {
    openPost(item);
    return;
  }
  window.location.hash = '#/website';
}

function itemTitle(item) {
  return cleanCopy(item.service) || cleanCopy(item.hook) || item.title || item.id;
}

function itemDate(item) {
  const raw = item?.post_date || item?.due_date || item?.week_of || item?.created_at;
  if (!raw) return null;
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function postedCount(list) {
  return (list || []).filter((p) => p.status === 'posted' || p.status === 'done').length;
}

export default function TodayPage(props) {
  void props;
  const data = useMarketingData();
  const [tab, setTab] = useState('facebook');
  const [showPrior, setShowPrior] = useState(false);

  const configured = data.configured;
  const waiting = configured && data.loading && !data.posts.length;
  const usingFixtures = !configured && !waiting;

  const today = usingFixtures ? FIXTURE_TODAY : data.today;
  const weekStart = usingFixtures ? FIXTURE_WEEK_START : data.weekStart;
  const weekEnd = usingFixtures ? FIXTURE_WEEK_END : data.weekEnd;
  const posts = usingFixtures ? FIXTURE_POSTS : data.posts;
  const tasks = usingFixtures ? FIXTURE_TASKS : (data.tasks || []);
  const health = usingFixtures ? FIXTURE_HEALTH : data.health;

  const { facebook, gbp } = partitionPosts(posts);
  const weekTasks = tasks.filter((t) => {
    const d = itemDate(t);
    return !d || (d >= weekStart && d <= weekEnd);
  });
  const activePosts = (tab === 'gbp' ? gbp : facebook)
    .slice()
    .sort((a, b) => String(a.post_date).localeCompare(b.post_date));

  const pendingPosts = usingFixtures
    ? posts.filter((p) => isPendingApproval(p.status))
    : data.pendingPosts;
  const pendingTasks = usingFixtures
    ? tasks.filter((t) => isPendingApproval(t.status))
    : data.pendingTasks;
  const waitingOnOwner = usingFixtures
    ? tasks.filter((t) => isWaitingOnOwner(t.status))
    : data.waitingOnOwner;
  const runRecovery = usingFixtures
    ? [...posts, ...tasks].filter((i) => isAttentionItem(i, { today, currentRunId: FIXTURE_HEALTH.run?.id }))
    : data.runRecovery;
  const currentRecovery = runRecovery;
  const priorRecovery = usingFixtures ? FIXTURE_PRIOR_RECOVERY : data.priorRecovery;
  const currentRunId = usingFixtures ? FIXTURE_HEALTH.run?.id : data.health?.run?.id;
  const grouped = { execution: [], verification: [], owner: [] };
  for (const item of currentRecovery) {
    const cls = recoveryClass(item, { today, currentRunId });
    if (grouped[cls]) grouped[cls].push(item);
  }
  const alertTotal = grouped.execution.length + grouped.verification.length + grouped.owner.length;
  const adapters = usingFixtures
    ? FIXTURE_ADAPTERS
    : deriveAdapters({ facebook, gbp, tasks, waitingOnOwner, runRecovery });
  const facebookOnGraph = facebook.filter(isOnGraph).length;
  const fbPosted = postedCount(facebook);
  const gbpPosted = postedCount(gbp);
  const gbpNative = gbp.filter((p) => p.status === 'scheduled_native').length;
  const runColor = health?.live === 'done' ? C.green
    : health?.live === 'error' ? C.red
      : health?.live === 'needs_verification' ? C.amber
        : C.indigo;

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
        <div className="errorBanner" role="alert">
          Live data unavailable. {data.error}
        </div>
      ) : null}

      <div className="summaryGrid">
        <div className="summaryCard">
          <div className="summaryValue" style={{ color: C.amber }}>{pendingPosts.length}</div>
          <div className="summaryLabel">Posts pending</div>
        </div>
        <div className="summaryCard">
          <div className="summaryValue" style={{ color: C.amber }}>{pendingTasks.length}</div>
          <div className="summaryLabel">Website pending</div>
        </div>
        <div className="summaryCard">
          <div className="summaryValue" style={{ color: C.amber }}>{waitingOnOwner.length}</div>
          <div className="summaryLabel">Waiting on owner</div>
        </div>
        <div className="summaryCard">
          <div className="summaryValue" style={{ color: runColor, fontSize: 18 }}>
            {health?.live || 'idle'}
          </div>
          <div className="summaryLabel">Run {health?.bucket || 'incomplete'}</div>
        </div>
        <div className="summaryCard" style={{ textAlign: 'left' }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {adapters.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  className="adapterDot"
                  aria-hidden="true"
                  style={{ background: ADAPTER_DOT[a.status] || C.muted }}
                />
                <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{a.label}</span>
                <span style={{ color: C.muted, fontSize: 11 }}>{a.status.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
          <div className="summaryLabel">Adapter readiness</div>
        </div>
      </div>

      {alertTotal > 0 ? (
        <div className="attentionBox">
          <div className="attentionHead">
            Needs attention ({alertTotal})
            <span style={{ color: C.muted, fontWeight: 500, letterSpacing: 0 }}>
              {grouped.execution.length ? ` · ${grouped.execution.length} execution` : ''}
              {grouped.verification.length ? ` · ${grouped.verification.length} verify` : ''}
              {grouped.owner.length ? ` · ${grouped.owner.length} owner` : ''}
            </span>
          </div>
          {CLASS_SECTIONS.map(({ cls, color, accent }) =>
            grouped[cls].length ? (
              <div key={cls} style={{ marginBottom: 6 }}>
                {grouped[cls].map((item) => (
                  <button
                    key={`alert-${item.id}`}
                    type="button"
                    className="ghostBtn"
                    style={{ display: 'block', color, fontSize: 12, marginBottom: 3, textAlign: 'left' }}
                    onClick={() => openItem(item)}
                  >
                    {accent} {itemDate(item) ? `${itemDate(item)} · ` : ''}{item.platform ? `${item.platform} · ` : ''}{itemTitle(item)} — {recoveryReason(item)}
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </div>
      ) : (
        <div className="allClear">All clear — nothing in this run needs attention.</div>
      )}

      {priorRecovery.length > 0 ? (
        <button
          type="button"
          className="ghostBtn"
          onClick={() => setShowPrior((v) => !v)}
        >
          {showPrior ? '▾' : '▸'} {priorRecovery.length} prior-week item{priorRecovery.length === 1 ? '' : 's'} (historical / skipped backlog)
        </button>
      ) : null}

      {showPrior && priorRecovery.length > 0 ? (
        <div className="attentionBox">
          {priorRecovery.map((item) => (
            <div key={`prior-${item.id}`} style={{ marginBottom: 6 }}>
              <div style={{ color: C.muted, fontSize: 12 }}>
                ⚠ {itemDate(item) ? `${itemDate(item)} · ` : ''}{item.platform ? `${item.platform} · ` : ''}{itemTitle(item)} — {recoveryReason(item)}
              </div>
              <div className="recoveryMeta" style={{ margin: '2px 0 0 12px' }}>
                {ageLabel(item, today) ? <span>age <strong style={{ color: C.muted }}>{ageLabel(item, today)}</strong></span> : null}
                <span>owner <strong style={{ color: C.muted }}>{ownerFor(item)}</strong></span>
                <span>next <strong style={{ color: C.muted }}>{nextActionFor(item)}</strong></span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {alertTotal > 0
        ? CLASS_SECTIONS.map(({ cls, title, color, border }) =>
          grouped[cls].length ? (
            <div key={cls} className="recoveryList">
              <div className="recoveryHead" style={{ color }}>
                {title} ({grouped[cls].length})
              </div>
              {grouped[cls].map((item) => (
                <article
                  key={`rec-${item.id}`}
                  className="recoveryCard"
                  style={{ border: `1px solid ${border}` }}
                  role="link"
                  tabIndex={0}
                  onClick={() => openItem(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openItem(item);
                    }
                  }}
                >
                  <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
                    {itemDate(item) ? `${itemDate(item)} · ` : ''}{item.platform ? `${item.platform} · ` : ''}{itemTitle(item)}
                  </div>
                  <div style={{ color, fontSize: 12, margin: '6px 0 8px' }}>{recoveryReason(item)}</div>
                  <div className="recoveryMeta">
                    {ageLabel(item, today) ? <span>age <strong style={{ color: C.text }}>{ageLabel(item, today)}</strong></span> : null}
                    <span>owner <strong style={{ color: C.text }}>{ownerFor(item)}</strong></span>
                    <span>next <strong style={{ color: C.text }}>{nextActionFor(item)}</strong></span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <ReadOnlyButton>Retry</ReadOnlyButton>
                    <ReadOnlyButton>Skip</ReadOnlyButton>
                    <ReadOnlyButton>Ack</ReadOnlyButton>
                  </div>
                </article>
              ))}
            </div>
          ) : null,
        )
        : null}

      <div className="tabRow">
        {[
          { key: 'facebook', label: 'Facebook', posted: fbPosted, total: facebook.length, onGraph: facebookOnGraph },
          { key: 'gbp', label: 'Google Business', posted: gbpPosted, total: gbp.length, native: gbpNative },
          { key: 'website', label: 'Website', posted: tasks.filter((t) => t.status === 'done').length, total: weekTasks.length },
        ].map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={active ? 'tabBtn active' : 'tabBtn'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="tabCount">
                {t.native != null
                  ? `${t.posted}/${t.total} · ${t.native} native`
                  : t.onGraph > t.posted
                    ? `${t.posted}/${t.total} · ${t.onGraph} on Graph`
                    : `${t.posted}/${t.total}`}
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'website' ? (
        weekTasks.length === 0 ? (
          <p>No website tasks this week.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {weekTasks.map((task) => (
              <button
                key={task.id || task.title}
                type="button"
                className="postRow"
                onClick={() => { window.location.hash = '#/website'; }}
              >
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
                    {task.title || task.id}
                  </div>
                  <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                    {task.type || 'task'} · {task.priority || '—'}
                  </div>
                </div>
                <StatusChip
                  label={String(task.status || '—').replace(/_/g, ' ').toUpperCase()}
                  color={task.status === 'done' ? C.green : task.status === 'error' || task.status === 'failed' ? C.red : C.amber}
                />
              </button>
            ))}
          </div>
        )
      ) : activePosts.length === 0 ? (
        <p>No posts scheduled this week.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {activePosts.map((post) => {
            const chip = chipForPost(post, today);
            const healthRow = postHealth(post);
            const isToday = post.post_date === today;
            const rowClass = `postRow${healthRow.state === 'red' ? ' alert' : isToday ? ' today' : ''}`;
            return (
              <button
                key={post.id}
                type="button"
                className={rowClass}
                onClick={() => openPost(post)}
                aria-label={`Open ${post.platform || 'post'} ${post.post_date || ''}`}
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
                <div style={{ width: 1, height: 36, background: '#2a2f45', flexShrink: 0 }} />
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
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
