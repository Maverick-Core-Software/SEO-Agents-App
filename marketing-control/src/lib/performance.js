/**
 * Pure performance-report helpers. Best-effort parsers — never throw on bad input.
 * Browser has no fs; VITE_OUTPUTS_DIR cannot be read from the Vite client.
 */

export const PHASE2_TREND_NOTE =
  'Week-over-week trends require Phase-2 structured store.';

export const CLIENT_FIXTURE_NOTE =
  'File outputs are not mounted in the browser; showing bundled fixtures. Week-over-week trends require Phase-2 structured store.';

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function safeString(value) {
  if (value == null) return '';
  try {
    return typeof value === 'string' ? value : String(value);
  } catch {
    return '';
  }
}

/** Dollars-and-cents display; unknown numbers stay "unknown". */
export function formatCents(cents) {
  const n = asNumber(cents);
  if (n == null) return 'unknown';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

/**
 * Best-effort markdown scrape: first heading → title; later headings,
 * `- **key**: value` bullets, and table rows → {label, value}.
 */
export function parseEngagementMarkdown(md) {
  let raw = '';
  try {
    raw = safeString(md);
  } catch {
    return { title: '', rows: [], raw: '' };
  }

  try {
    const rows = [];
    let title = '';
    let tableHeaders = null;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        tableHeaders = null;
        continue;
      }

      const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        tableHeaders = null;
        const text = heading[1].replace(/\s+/g, ' ').trim();
        if (!title) title = text;
        else rows.push({ label: text, value: '' });
        continue;
      }

      if (trimmed.startsWith('|')) {
        const cells = trimmed
          .split('|')
          .slice(1, -1)
          .map((c) => c.replace(/\*+/g, '').trim());
        if (cells.length === 0) continue;
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (!tableHeaders) {
          tableHeaders = cells;
          continue;
        }
        const label = cells.filter(Boolean).slice(0, 3).join(' · ') || 'row';
        const value = tableHeaders
          .map((h, i) => `${h}: ${cells[i] ?? ''}`)
          .join(' · ');
        rows.push({ label, value });
        continue;
      }

      tableHeaders = null;

      // Collector style is `- **Key:** value`; also accept `**Key**: value`.
      const kv = trimmed.match(/^(?:[-*]\s+)?\*\*(.+?)\*\*:?\s+(.+)$/);
      if (kv) {
        rows.push({
          label: kv[1].replace(/[:—-]\s*$/, '').trim(),
          value: kv[2].trim(),
        });
      }
    }

    return { title, rows, raw };
  } catch {
    return { title: '', rows: [], raw };
  }
}

/**
 * Flatten a JSON-shaped boost ledger. Missing numbers → null.
 * remainingCents is cap − spent when both numbers are present.
 */
export function summarizeBoostLedger(ledger) {
  try {
    const src = ledger && typeof ledger === 'object' ? ledger : {};
    const week = src.week == null || src.week === '' ? null : String(src.week);
    const spentCents = asNumber(src.spentCents);
    const capCents = asNumber(src.capCents);
    const remainingCents =
      spentCents == null || capCents == null ? null : capCents - spentCents;
    const entries = Array.isArray(src.entries) ? src.entries : [];
    return { week, spentCents, capCents, remainingCents, entries };
  } catch {
    return {
      week: null,
      spentCents: null,
      capCents: null,
      remainingCents: null,
      entries: [],
    };
  }
}

/** ours − competitor; both must be numeric for a gap. */
export function reviewCountComparison(ours, competitor) {
  const oursN = asNumber(ours);
  const competitorN = asNumber(competitor);
  const gap = oursN == null || competitorN == null ? null : oursN - competitorN;
  let note = PHASE2_TREND_NOTE;
  if (gap != null) {
    if (gap === 0) {
      note = `Tied at ${oursN} reviews. ${PHASE2_TREND_NOTE}`;
    } else if (gap < 0) {
      note = `${Math.abs(gap)} reviews behind. ${PHASE2_TREND_NOTE}`;
    } else {
      note = `${gap} reviews ahead. ${PHASE2_TREND_NOTE}`;
    }
  }
  return { ours: oursN, competitor: competitorN, gap, note };
}

/** Explain that VITE_OUTPUTS_DIR cannot be read in the browser. */
export function outputsDirNote() {
  const dir = import.meta.env?.VITE_OUTPUTS_DIR;
  if (!dir) return CLIENT_FIXTURE_NOTE;
  return `VITE_OUTPUTS_DIR is set, but file reads from the Vite client are not possible (browser has no fs). ${CLIENT_FIXTURE_NOTE}`;
}
