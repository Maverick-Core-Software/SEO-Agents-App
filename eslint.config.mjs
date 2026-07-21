// ponytail: deliberately minimal — only the rules that catch real shipped bugs.
// no-undef exists because commit ebfde1d deleted `const scheduleFile` but left a
// reference, which crashed every weekly FB run for a week (2026-07-17/20).
// Upgrade path: `eslint.configs.recommended` if we ever want the full set.
import globals from 'globals';

export default [
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    // These files pass callbacks to Playwright's page.evaluate(), which run in
    // the browser — document/NodeFilter are real there, not no-undef bugs.
    files: [
      'scripts/facebook-poster.mjs',
      'scripts/verify-gbp-posts.mjs',
      'scripts/gbp-poster/driver.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
