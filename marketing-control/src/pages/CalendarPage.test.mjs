import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('CalendarPage live vs fixture', () => {
  const src = readFileSync(join(here, 'CalendarPage.jsx'), 'utf8');

  it('does not swap to fixtures when Supabase is configured', () => {
    assert.ok(src.includes('useMarketingData'));
    assert.ok(src.includes("usingFixtures = !data.configured"));
    assert.equal(src.includes("setSource('fixture')"), false);
  });

  it('highlights today and links website cells', () => {
    assert.ok(src.includes('todayCell'));
    assert.ok(src.includes('#/website'));
  });
});
