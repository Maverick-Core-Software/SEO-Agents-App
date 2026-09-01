import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('TodayPage polish', () => {
  const src = readFileSync(join(here, 'TodayPage.jsx'), 'utf8');

  it('shows all-clear instead of a red empty recovery heading', () => {
    assert.ok(src.includes('All clear'));
    assert.equal(src.includes('No items need attention.'), false);
  });

  it('opens recovery items and includes a website tab', () => {
    assert.ok(src.includes('openItem'));
    assert.ok(src.includes("key: 'website'"));
    assert.ok(src.includes('deriveAdapters'));
  });

  it('does not nest write buttons inside a recovery-card button', () => {
    assert.ok(src.includes('className="recoveryCard"'));
    assert.equal(/<button[^>]*className="recoveryCard"/.test(src), false);
    assert.ok(src.includes('<article'));
  });
});
