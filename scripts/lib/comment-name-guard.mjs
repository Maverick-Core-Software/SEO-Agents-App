/**
 * comment-name-guard.mjs
 * Name handling for the Facebook comment reply agent.
 *
 * Facebook does not return `from` on comments left by ordinary users on a Page
 * post (post-2020 privacy changes: you need Page Public Content Access, or the
 * commenter must have authorized the app). Observed live on this Page: the
 * Page's own comments carry `from`, every real customer comment has
 * `from: null`.
 *
 * So for real customers we never know the name. Anything that hands a model a
 * placeholder name — or tells it to "use their first name" — makes it invent
 * one, which is how customers got called Sarah and Mike.
 */

/** Resolve the commenter's name, or report honestly that we don't have one. */
export function resolveCommenterName(comment, ourPageId) {
  const raw = typeof comment?.from?.name === 'string' ? comment.from.name.trim() : '';
  const fromId = comment?.from?.id;

  // Our own Page name is never a customer name.
  if (!raw || (ourPageId && fromId && String(fromId) === String(ourPageId))) {
    return { known: false, full: null, first: null };
  }

  const first = raw.split(/\s+/)[0];
  // Guard against Graph returning an opaque/placeholder value.
  if (!/^[\p{L}][\p{L}'’-]*$/u.test(first)) return { known: false, full: null, first: null };

  return { known: true, full: raw, first };
}

// "Hey Sarah, ..." / "Thanks, Mike — ..." — greeting followed by a name.
const GREETING_NAME = /^(hey|hi|hello|yo|thanks so much|thanks|thank you|appreciate it|appreciate that|awesome|good question|haha|ha)([,!\s]+)([A-Z][a-zA-Z'’-]+)\b/i;
// Bare leading vocative: "Mike, that depends ..." (name, comma, lowercase word).
const LEADING_VOCATIVE = /^([A-Z][a-zA-Z'’-]+),\s+(?=[a-z])/;
// Trailing vocative: "... shoot us a photo, Sarah!"
const TRAILING_VOCATIVE = /,\s*([A-Z][a-zA-Z'’-]+)(?=\s*[!.?]|\s*$)/g;

// Words that sit in a vocative slot but are not names. Without this, "Hey,
// thanks for sharing!" loses its greeting and "Sure, we can" loses "Sure".
const NOT_A_NAME = new Set([
  'hey', 'hi', 'hello', 'yo', 'thanks', 'thank', 'appreciate', 'awesome', 'haha', 'ha',
  'sure', 'yes', 'yeah', 'yep', 'no', 'nope', 'absolutely', 'definitely', 'sorry', 'ok',
  'okay', 'well', 'honestly', 'actually', 'right', 'true', 'nice', 'great', 'good',
  'congrats', 'congratulations', 'man', 'friend', 'folks', 'sir', 'maam',
]);
const isNotAName = (n) => NOT_A_NAME.has(n.toLowerCase().replace(/[''’]/g, ''));

/**
 * Remove any personal name used as a vocative unless it is the one name we
 * actually know. Deterministic backstop for the prompt rules.
 * Returns { text, stripped } so callers can log when the model misbehaved.
 */
export function stripUnknownNames(reply, allowedFirst = null) {
  if (typeof reply !== 'string' || !reply) return { text: '', stripped: false };

  const allowed = allowedFirst ? allowedFirst.toLowerCase() : null;
  const isAllowed = (n) => allowed !== null && n.toLowerCase() === allowed;

  let stripped = false;
  let out = reply;

  out = out.replace(GREETING_NAME, (m, greet, sep, name) => {
    // The /i flag lets the greeting match any case, so re-check that the
    // candidate is genuinely capitalized — "Hey, thanks" must keep "thanks".
    if (isAllowed(name) || isNotAName(name) || name[0] !== name[0].toUpperCase()) return m;
    stripped = true;
    return greet;
  });

  out = out.replace(LEADING_VOCATIVE, (m, name) => {
    if (isAllowed(name) || isNotAName(name)) return m;
    stripped = true;
    return '';
  });

  out = out.replace(TRAILING_VOCATIVE, (m, name) => {
    if (isAllowed(name) || isNotAName(name)) return m;
    stripped = true;
    return '';
  });

  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,!.?])/g, '$1').trim();
  // Re-capitalize if a strip left the sentence starting lowercase.
  if (stripped) out = out.replace(/^([a-z])/, (c) => c.toUpperCase());

  return { text: out, stripped };
}
