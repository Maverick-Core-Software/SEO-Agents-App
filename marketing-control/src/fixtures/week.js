// Fixture week 2026-08-24 (Mon) .. 2026-08-30 (Sun). FIXTURE_TODAY is Sunday
// so scheduled-today and overdue chips both appear in the demo.

import { postHealth } from '../lib/postHealth.js';
import { POST_STATUS_COLOR, POST_STATUS_LABEL } from '../lib/status.js';

export const FIXTURE_TODAY = '2026-08-30';
export const FIXTURE_WEEK_START = '2026-08-24';
export const FIXTURE_WEEK_END = '2026-08-30';

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const RUN_ID = 'fx-run-2026-08-24';

export function cleanCopy(str) {
  return String(str || '').replace(/\*\*/g, '').trim();
}

export function dayLabelFor(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAY_LABELS[dow === 0 ? 6 : dow - 1];
}

export function isRecoveryItem(item) {
  const status = String(item?.status || '');
  if (status === 'error' || status === 'needs_verification') return true;
  return status === 'posting' && !item?.posted_at;
}

export function chipForPost(post, today) {
  const status = String(post?.status || '');
  const isToday = post?.post_date === today;
  const isPast = Boolean(post?.post_date && post.post_date < today);
  const health = postHealth(post);

  let color = POST_STATUS_COLOR[status] || (isPast ? '#ef4444' : '#6b7280');
  let label = POST_STATUS_LABEL[status] || (isPast ? 'MISSED?' : 'SCHEDULED');
  let kind =
    status === 'scheduled_native' ? 'native'
      : status === 'done' ? 'posted'
        : (status || 'scheduled');

  // scheduled_native is Google's 9am CT scheduler — never POST TODAY / OVERDUE.
  if (status === 'scheduled') {
    if (isToday) {
      color = '#f59e0b';
      label = 'POST TODAY';
      kind = 'today';
    } else if (isPast) {
      color = '#ef4444';
      label = 'OVERDUE';
      kind = 'overdue';
    } else {
      kind = 'scheduled';
    }
  }

  if (health.state === 'red') {
    color = '#ef4444';
    label = 'CHECK';
    kind = 'check';
  }

  return { label, color, kind };
}

function post(partial) {
  return {
    run_id: RUN_ID,
    type: 'photo',
    media_status: 'photo',
    platform_post_id: null,
    posted_at: null,
    error: null,
    hook: '',
    cta: '',
    ...partial,
  };
}

export const FIXTURE_POSTS = [
  // Facebook Mon–Sun
  post({
    id: 'fb-mon',
    platform: 'facebook',
    day: 1,
    post_date: '2026-08-24',
    type: 'video',
    media_status: 'video',
    service: '**Panel Upgrade**',
    hook: '**Same-week panel upgrades** in Houston',
    status: 'posted',
    platform_post_id: 'fb_1001',
    posted_at: '2026-08-24T14:05:00-05:00',
  }),
  post({
    id: 'fb-tue',
    platform: 'facebook',
    day: 2,
    post_date: '2026-08-25',
    type: 'video',
    media_status: 'downgraded',
    service: '**EV Charger**',
    hook: 'Level 2 charger, no panel surprise',
    status: 'posted',
    platform_post_id: 'fb_1002',
    posted_at: '2026-08-25T09:12:00-05:00',
  }),
  post({
    id: 'fb-wed',
    platform: 'facebook',
    day: 3,
    post_date: '2026-08-26',
    type: 'photo',
    media_status: 'photo',
    service: '**Whole-home Surge**',
    hook: 'One hit can fry every board',
    status: 'scheduled',
  }),
  post({
    id: 'fb-thu',
    platform: 'facebook',
    day: 4,
    post_date: '2026-08-27',
    type: 'photo',
    media_status: 'photo',
    service: '**Recessed Lighting**',
    hook: 'Kitchen cans that actually match',
    status: 'pending_approval',
  }),
  post({
    id: 'fb-fri',
    platform: 'facebook',
    day: 5,
    post_date: '2026-08-28',
    type: 'video',
    media_status: 'none',
    service: '**Generator Interlock**',
    hook: 'Storm-ready transfer without a full ATS',
    status: 'error',
    error: 'Facebook Graph 190 — token expired mid-upload',
  }),
  post({
    id: 'fb-sat',
    platform: 'facebook',
    day: 6,
    post_date: '2026-08-29',
    type: 'photo',
    media_status: 'photo',
    service: '**Outlet Repair**',
    hook: 'Hot outlets are a fire call, not a DIY',
    status: 'needs_verification',
    error: 'Published but permalink probe timed out',
  }),
  post({
    id: 'fb-sun',
    platform: 'facebook',
    day: 7,
    post_date: '2026-08-30',
    type: 'photo',
    media_status: 'photo',
    service: '**Ceiling Fan**',
    hook: 'Rated box + correct downrod for 12ft',
    status: 'scheduled',
  }),

  // GBP Mon–Sun
  post({
    id: 'gbp-mon',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-24',
    type: 'photo',
    media_status: 'photo',
    service: '**Panel Upgrade**',
    hook: 'Same-week 200A service in Houston',
    status: 'posted',
    platform_post_id: 'gbp_2001',
    posted_at: '2026-08-24T09:04:00-05:00',
  }),
  post({
    id: 'gbp-tue',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-25',
    type: 'photo',
    media_status: 'photo',
    service: '**EV Charger**',
    hook: 'Home Level 2, load-calc first',
    status: 'scheduled_native',
  }),
  post({
    id: 'gbp-wed',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-26',
    type: 'photo',
    media_status: 'downgraded',
    service: '**Whole-home Surge**',
    hook: 'Type 2 SPD at the panel',
    status: 'posted',
    platform_post_id: 'gbp_2003',
    posted_at: '2026-08-26T09:07:00-05:00',
  }),
  post({
    id: 'gbp-thu',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-27',
    type: 'photo',
    media_status: 'photo',
    service: '**Recessed Lighting**',
    hook: 'IC-rated cans for insulated ceilings',
    status: 'scheduled_native',
  }),
  post({
    id: 'gbp-fri',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-28',
    type: 'photo',
    media_status: 'photo',
    service: '**Generator Interlock**',
    hook: 'Code-legal interlock kit, not a suicide cord',
    status: 'posting',
  }),
  post({
    id: 'gbp-sat',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-29',
    type: 'photo',
    media_status: 'photo',
    service: '**Outlet Repair**',
    hook: 'GFCI where the code actually requires it',
    status: 'pending_approval',
  }),
  post({
    id: 'gbp-sun',
    platform: 'gbp',
    day: null,
    post_date: '2026-08-30',
    type: 'photo',
    media_status: 'photo',
    service: '**Ceiling Fan**',
    hook: 'Brace + box rated for the fan you bought',
    status: 'scheduled_native',
  }),
];

export const FIXTURE_TASKS = [
  {
    id: 'task-hours',
    run_id: RUN_ID,
    type: 'seo_fix',
    priority: 'high',
    title: 'Fix hours schema on contact page',
    status: 'error',
    error: 'Website adapter crashed on fenced HTML',
  },
  {
    id: 'task-blog',
    run_id: RUN_ID,
    type: 'blog_post',
    priority: 'medium',
    title: 'Panel upgrade blog',
    status: 'pending_approval',
    error: null,
  },
];

export const FIXTURE_ADAPTERS = [
  { id: 'facebook', label: 'Facebook', status: 'live_ready' },
  { id: 'gbp', label: 'GBP', status: 'worker' },
  { id: 'website', label: 'Website', status: 'live_ready' },
];

export const FIXTURE_HEALTH = {
  run: { id: RUN_ID, week_of: FIXTURE_WEEK_START, status: 'executing' },
  posts: FIXTURE_POSTS,
  live: 'error',
  bucket: 'blocked',
};
