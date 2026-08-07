// scripts/lib/schedule-text.mjs
// Single source of truth for cleaning schedule-block field values.
// The content agent emits markdown: **bold** and `code-ticks`. Older parsers
// only stripped ** which left literal backticks in photo_file, so posters looked
// for a file named `` `name.JPG` `` and silently fell back to text. Strip both.

const BLANK_RE = /^\*?\(?\s*blank\s*\)?\*?$/i; // matches (blank), *(blank)*, blank
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

export function cleanField(str) {
  return (str || '')
    .replace(/\*\*/g, '')   // bold
    .replace(/`/g, '')      // code ticks
    .trim();
}

export function normalizePhotoFile(raw) {
  const v = cleanField(raw);
  if (!v) return '';
  if (BLANK_RE.test(v)) return '';
  if (IMAGE_EXT_RE.test(v)) return v;
  // The agent sometimes annotates the filename — `IMG_2329.JPG *(best-effort
  // pick — curator to confirm)*` — so a bare extension check at end-of-string
  // would drop the photo entirely. Pull the first filename token out instead.
  // Defensive: a leaked prompt or label is not a filename — values with no
  // image extension anywhere are still rejected.
  const m = v.match(/[\w][\w.\- ]*?\.(jpe?g|png|gif|webp|bmp|tiff?)\b/i);
  return m ? m[0].trim() : '';
}
