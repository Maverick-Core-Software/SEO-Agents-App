// Pure helpers for deciding the truthful per-post health of a weekly_post row.
// Port of MCC src/lib/seoRules.js postHealth / healthReason — identical behavior.
//
// A post is RED when ANY of these hold:
//   - media_status is a fallback ('downgraded' or 'none') — video became photo / no media
//   - platform_post_id is null on a 'posted' row — FB never returned a real post id
//   - intended type !== actual media (type 'video' but media_status !== 'video')
//
// GREEN only when status === 'posted' AND none of the red conditions hold.
// Everything else (scheduled, pending, error handled elsewhere) is NEUTRAL.

const RED_REASONS = {
  downgraded: 'VIDEO → PHOTO',
  none: 'NO MEDIA',
  no_post_id: 'NO POST ID',
  type_mismatch: 'TYPE MISMATCH',
};

const FALLBACK_MEDIA = new Set(['downgraded', 'none']);

export function postHealth(post) {
  if (!post || post.status !== 'posted') return { state: 'neutral', reason: null };

  const media = post.media_status;

  if (FALLBACK_MEDIA.has(media)) {
    return { state: 'red', reason: RED_REASONS[media] || 'FALLBACK' };
  }
  if (!post.platform_post_id) {
    return { state: 'red', reason: RED_REASONS.no_post_id };
  }
  if (post.type === 'video' && media !== 'video') {
    return { state: 'red', reason: RED_REASONS.type_mismatch };
  }

  return { state: 'green', reason: null };
}

export function healthReason(post) {
  const h = postHealth(post);
  return h.state === 'red' ? h.reason : null;
}
