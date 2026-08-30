/** Bundled sample data. Not live Graph / ledger / GBP numbers. */

export const FIXTURE_ENGAGEMENT_MD = `# Facebook Engagement Report — Week of 2026-08-24

**Status:** SAMPLE FIXTURE — not live Graph data. Grizzly Electrical Solutions (Dallas–Fort Worth).

## Top Performing Posts

| Rank | Day | Type | Goal | CTA | Impressions | Engagement | Rate |
|------|-----|------|------|-----|-------------|------------|------|
| 1 | 2 | photo | Panel upgrade | Save this | 412 | 28 | 6.80% |
| 2 | 5 | video | EV charger install | Tag a friend | 287 | 19 | 6.62% |
| 3 | 1 | photo | Storm damage / generator | Call now | 194 | 9 | 4.64% |

## Page totals

- **Reach**: 890
- **Likes**: 41
- **Comments**: 11
- **Shares**: 4
- **Video views**: 86

## Recommendations for Next Week

- **Double down on:** before/after panel-upgrade photos (highest organic reach in this sample)
- **Drop:** phone-number-only CTAs
- **Test:** 15–25s Reel with text overlay for sound-off viewers
`;

export const FIXTURE_BOOST_LEDGER = {
  week: '2026-08-24',
  capCents: 5000,
  spentCents: 0,
  entries: [
    {
      key: 'day4-ev-charger',
      status: 'skipped',
      decision: 'conditional',
      note: 'BOOST BUDGET SUMMARY: whichever performs better — not machine-decidable. Sample fixture; $0 reserved.',
      spentCents: 0,
    },
  ],
};

export const FIXTURE_BASELINES = [
  {
    week: '2026-08-28',
    title: 'Weekly baseline',
    href: null,
    excerpt:
      'Grizzly Electrical Solutions — contact form (CF7) is live at https://www.grizzlyelectricaltx.com/. Sample excerpt shipped with the app; live knowledge/baselines files are not mounted in the browser.',
  },
];

export const FIXTURE_REVIEWS = {
  ours: 154,
  competitor: 1500,
  competitorName: 'W3 (schedule doc)',
};
