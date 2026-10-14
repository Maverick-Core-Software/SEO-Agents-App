// scripts/lib/photo-name.mjs
// Photo file names as they appear in stored records. The Windows PC writes absolute
// paths (C:\...\GBP Post Photos\a.JPG) into Supabase, the photo cache and the selection
// manifest, and the Linux LXC reads them back. path.basename only splits on the host's
// own separator, so these helpers split on both '\' and '/' whatever platform runs them.

/** Last segment of a stored photo path, splitting on either separator. '' when there is none. */
export function photoBasename(p) {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Comparison key: basename, Unicode NFC, lower-cased (the photo folders are case-insensitive on Windows). */
export function photoKey(p) {
  return photoBasename(p).normalize('NFC').toLowerCase();
}

/** True when both values name the same photo file. An empty name never matches. */
export function samePhotoName(a, b) {
  const key = photoKey(a);
  return key !== '' && key === photoKey(b);
}

/** Photo paths inside one stored photo_file value; multi-file values split on the separators facebook-poster accepts. */
export function photoFilesIn(value) {
  return String(value ?? '').split(/[,|;]+/).map((s) => s.trim()).filter(Boolean);
}
