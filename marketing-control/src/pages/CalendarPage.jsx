import { addDays, chicagoToday, sundayOfWeek } from '../lib/week.js';
import { POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';
import { StatusChip } from '../components/StatusChip.jsx';
import { useMarketingData } from '../lib/useMarketingData.js';
import { FIXTURE_CALENDAR_POSTS, FIXTURE_CALENDAR_TASKS } from '../fixtures/approval.js';

const C = {
  bg: '#0f1117',
  surface: '#161922',
  border: '#2a2f45',
  text: '#f1f5f9',
  muted: '#94a3b8',
  indigo: '#6366f1',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatMd(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
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

function countBucket(status) {
  const s = String(status || '');
  if (s === 'posted' || s === 'done') return 'posted';
  if (s === 'error' || s === 'needs_verification') return 'error';
  if (
    s === 'pending_approval' ||
    s === 'needs_approval' ||
    s === 'approved' ||
    s === 'scheduled' ||
    s === 'scheduled_native' ||
    s === 'posting'
  ) {
    return 'pending';
  }
  return 'other';
}

function weekCounts(posts) {
  const counts = { pending: 0, posted: 0, error: 0 };
  for (const post of posts || []) {
    const bucket = countBucket(post.status);
    if (bucket !== 'other') counts[bucket] += 1;
  }
  return counts;
}

function itemDate(row, posts) {
  if (row?.due_date) return String(row.due_date).slice(0, 10);
  if (row?.post_date) return String(row.post_date).slice(0, 10);
  if (row?.run_id) {
    const match = (posts || []).find((p) => p.run_id === row.run_id && p.post_date);
    if (match) return String(match.post_date).slice(0, 10);
  }
  if (row?.week_of) return String(row.week_of).slice(0, 10);
  if (row?.created_at) return String(row.created_at).slice(0, 10);
  return '';
}

function inWeek(iso, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  return iso >= weekStart && iso <= weekEnd;
}

function openPost(post) {
  try {
    sessionStorage.setItem('mc.detailPost', JSON.stringify(post));
  } catch {
    // private mode / quota — still navigate
  }
  window.location.hash = post?.id ? `#/detail/${post.id}` : '#/detail';
}

function CountPill({ label, value, color }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 12,
        color: C.muted,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
      {label} {value}
    </span>
  );
}

function PostChip({ post }) {
  const color = statusColor(post.status);
  return (
    <button
      type="button"
      onClick={() => openPost(post)}
      aria-label={`Open ${post.platform || 'post'} ${post.post_date || ''}`}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 6,
        padding: '4px 6px',
        color: C.text,
        cursor: 'pointer',
        font: 'inherit',
        marginBottom: 4,
      }}
    >
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
        {post.service || post.hook || post.platform}
      </div>
      <StatusChip label={statusLabel(post.status)} color={color} />
    </button>
  );
}

function WeekCard({ weekStart, posts, tasks, isCurrent, today }) {
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(weekStart, n));
  const weekPosts = posts.filter((p) => inWeek(String(p.post_date || ''), weekStart));
  const weekTasks = tasks.filter((t) => inWeek(itemDate(t, posts), weekStart));
  const counts = weekCounts(weekPosts);
  const grid = {
    display: 'grid',
    gridTemplateColumns: '72px repeat(7, minmax(88px, 1fr))',
    gap: 6,
    minWidth: 720,
  };

  function cellPosts(date, platform) {
    return weekPosts.filter(
      (p) => p.post_date === date && String(p.platform || '').toLowerCase() === platform,
    );
  }

  function cellTasks(date) {
    return weekTasks.filter((t) => itemDate(t, posts) === date);
  }

  return (
    <article
      style={{
        background: C.surface,
        border: `1px solid ${isCurrent ? C.indigo : C.border}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: C.text }}>
          {isCurrent ? 'This week' : 'Week of'} {formatMd(weekStart)} – {formatMd(days[6])}
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <CountPill label="pending" value={counts.pending} color={POST_STATUS_COLOR.pending_approval} />
          <CountPill label="posted" value={counts.posted} color={POST_STATUS_COLOR.posted} />
          <CountPill label="error" value={counts.error} color={POST_STATUS_COLOR.error} />
          <CountPill label="website" value={weekTasks.length} color={C.indigo} />
        </div>
      </header>
      <div style={{ overflowX: 'auto' }}>
        <div style={grid}>
          <div />
          {days.map((date, i) => (
            <div key={date} className={date === today ? 'todayCell' : undefined} style={{ color: C.muted, fontSize: 11, padding: 4 }}>
              <div>{DOW[i]}{date === today ? ' · today' : ''}</div>
              <div style={{ color: C.text }}>{formatMd(date)}</div>
            </div>
          ))}
          <div style={{ color: C.muted, fontSize: 12, paddingTop: 4 }}>Facebook</div>
          {days.map((date) => (
            <div key={`fb-${date}`}>
              {cellPosts(date, 'facebook').map((post) => (
                <PostChip key={post.id} post={post} />
              ))}
            </div>
          ))}
          <div style={{ color: C.muted, fontSize: 12, paddingTop: 4 }}>GBP</div>
          {days.map((date) => (
            <div key={`gbp-${date}`}>
              {cellPosts(date, 'gbp').map((post) => (
                <PostChip key={post.id} post={post} />
              ))}
            </div>
          ))}
          <div style={{ color: C.muted, fontSize: 12, paddingTop: 4 }}>Website</div>
          {days.map((date) => {
            const n = cellTasks(date).length;
            return (
              <button
                key={`web-${date}`}
                type="button"
                onClick={() => { if (n) window.location.hash = '#/website'; }}
                disabled={!n}
                style={{
                  color: n ? C.text : C.muted,
                  fontSize: 12,
                  paddingTop: 4,
                  background: 'transparent',
                  border: 0,
                  textAlign: 'left',
                  cursor: n ? 'pointer' : 'default',
                  font: 'inherit',
                }}
              >
                {n ? `${n} task${n === 1 ? '' : 's'}` : '—'}
              </button>
            );
          })}
        </div>
      </div>
    </article>
  );
}

export default function CalendarPage(props) {
  void props;
  const data = useMarketingData();
  const today = data.today || chicagoToday();
  const currentSunday = sundayOfWeek(today);
  const weekStarts = [0, -7, -14, -21].map((n) => addDays(currentSunday, n));
  const usingFixtures = !data.configured;
  const posts = usingFixtures ? FIXTURE_CALENDAR_POSTS : data.lookbackPosts;
  const tasks = usingFixtures ? FIXTURE_CALENDAR_TASKS : data.tasks;
  const source = usingFixtures ? 'fixture' : 'live';

  return (
    <section className="page">
      <h1>Content Calendar</h1>
      <p className="liveNote">
        Current week and previous 3 weeks. Click a post to open Content Detail.
      </p>
      {data.error ? <div className="errorBanner" role="alert">{data.error}</div> : null}
      {source === 'fixture' ? (
        <p className="liveNote">
          Showing fixture calendar (Supabase is not configured).
        </p>
      ) : null}
      {data.configured && !data.loading && posts.length === 0 ? (
        <p className="liveNote">No posts in the last 4 weeks.</p>
      ) : null}
      {weekStarts.map((weekStart) => (
        <WeekCard
          key={weekStart}
          weekStart={weekStart}
          posts={posts}
          tasks={tasks}
          isCurrent={weekStart === currentSunday}
          today={today}
        />
      ))}
    </section>
  );
}
