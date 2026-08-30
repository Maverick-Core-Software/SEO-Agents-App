import {
  parseEngagementMarkdown,
  summarizeBoostLedger,
  reviewCountComparison,
  outputsDirNote,
  formatCents,
  PHASE2_TREND_NOTE,
} from '../lib/performance.js';
import {
  FIXTURE_ENGAGEMENT_MD,
  FIXTURE_BOOST_LEDGER,
  FIXTURE_BASELINES,
  FIXTURE_REVIEWS,
} from '../fixtures/performance.js';

const C = {
  bg: '#0f1117',
  surface: '#161922',
  border: '#2a2f45',
  text: '#f1f5f9',
  muted: '#94a3b8',
  indigo: '#6366f1',
};

const card = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 16,
};

const h2 = {
  margin: '0 0 12px',
  fontSize: 16,
  fontWeight: 650,
  color: C.text,
};

const muted = { margin: 0, color: C.muted, fontSize: 13 };

const statGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  gap: 10,
  marginBottom: 12,
};

const statBox = {
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: '10px 12px',
};

const labelStyle = {
  display: 'block',
  color: C.muted,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 4,
};

const valueStyle = { color: C.text, fontSize: 16, fontWeight: 600 };

function Stat({ label, value }) {
  return (
    <div style={statBox}>
      <span style={labelStyle}>{label}</span>
      <div style={valueStyle}>{value}</div>
    </div>
  );
}

export default function PerformancePage(props) {
  void props;
  const engagement = parseEngagementMarkdown(FIXTURE_ENGAGEMENT_MD);
  const boost = summarizeBoostLedger(FIXTURE_BOOST_LEDGER);
  const reviews = reviewCountComparison(FIXTURE_REVIEWS.ours, FIXTURE_REVIEWS.competitor);
  const keyStats = engagement.rows.filter((row) => row.value);

  return (
    <section className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ color: C.text }}>Performance</h1>
        <p style={muted}>{outputsDirNote()}</p>
      </div>

      <section style={card} aria-labelledby="perf-engagement">
        <h2 id="perf-engagement" style={h2}>
          {engagement.title || 'Facebook engagement'}
        </h2>
        {keyStats.length === 0 ? (
          <p style={muted}>No stats parsed from the sample engagement report.</p>
        ) : (
          <div style={statGrid}>
            {keyStats.map((row) => (
              <Stat key={`${row.label}:${row.value}`} label={row.label} value={row.value} />
            ))}
          </div>
        )}
        <details>
          <summary style={{ cursor: 'pointer', color: C.muted, fontSize: 13 }}>
            Raw markdown
          </summary>
          <pre
            style={{
              margin: '10px 0 0',
              overflow: 'auto',
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 12,
              color: C.text,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {engagement.raw}
          </pre>
        </details>
      </section>

      <section style={card} aria-labelledby="perf-boost">
        <h2 id="perf-boost" style={h2}>
          Boost ledger
        </h2>
        <p style={{ ...muted, marginBottom: 12 }}>
          Week {boost.week || 'unknown'} · $50/wk cap is 5000 cents.
        </p>
        {boost.spentCents == null ? (
          <p style={muted}>{PHASE2_TREND_NOTE}</p>
        ) : (
          <div style={statGrid}>
            <Stat label="Cap" value={formatCents(boost.capCents)} />
            <Stat label="Spent" value={formatCents(boost.spentCents)} />
            <Stat label="Remaining" value={formatCents(boost.remainingCents)} />
          </div>
        )}
        {boost.entries.length === 0 ? (
          <p style={muted}>No ledger entries this week.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                color: C.text,
              }}
            >
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Key</th>
                  <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Status</th>
                  <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Decision</th>
                  <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Note</th>
                </tr>
              </thead>
              <tbody>
                {boost.entries.map((entry, i) => (
                  <tr key={entry.key || i}>
                    <td style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>
                      {entry.key || '—'}
                    </td>
                    <td style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>
                      {entry.status || '—'}
                    </td>
                    <td style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>
                      {entry.decision || '—'}
                    </td>
                    <td style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, color: C.muted }}>
                      {entry.note || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={card} aria-labelledby="perf-baselines">
        <h2 id="perf-baselines" style={h2}>
          Weekly baselines
        </h2>
        {FIXTURE_BASELINES.map((item) => (
          <article
            key={`${item.week}:${item.title}`}
            style={{
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 12,
              marginBottom: 8,
            }}
          >
            <div style={{ color: C.indigo, fontSize: 12, marginBottom: 4 }}>{item.week}</div>
            <div style={{ fontWeight: 600, color: C.text, marginBottom: 6 }}>
              {item.href ? (
                <a href={item.href} style={{ color: C.indigo }}>
                  {item.title}
                </a>
              ) : (
                item.title
              )}
            </div>
            <p style={muted}>{item.excerpt}</p>
          </article>
        ))}
      </section>

      <section style={card} aria-labelledby="perf-reviews">
        <h2 id="perf-reviews" style={h2}>
          Review count comparison
        </h2>
        <div style={statGrid}>
          <Stat label="Grizzly Electrical" value={reviews.ours ?? 'unknown'} />
          <Stat
            label={FIXTURE_REVIEWS.competitorName}
            value={reviews.competitor == null ? 'unknown' : `~${reviews.competitor}`}
          />
          <Stat
            label="Gap"
            value={reviews.gap == null ? 'unknown' : reviews.gap}
          />
        </div>
        <p style={muted}>{reviews.note}</p>
      </section>
    </section>
  );
}
