/**
 * node --test scripts/lib/parse-website-tasks.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFormatInstructionTitle,
  isOwnerWaitStatus,
  isWebsiteTaskExecutable,
  extractTaskTitle,
  parseWebsiteTasks,
  websiteTaskTopicFingerprint,
  isDuplicateOwnerWaitTopic,
  shouldSkipStaleWebsitePending,
} from './parse-website-tasks.mjs';

const BLOG_QUEUE_SNIPPET = `
### T-GES-20260814-005 — [BLOG POST] Generator Interlock Kit Cost in DFW — 2026 Guide

| Field | Value |
|---|---|
| **Task ID** | \`T-GES-20260814-005\` |
| **Task Type** | \`content_update\` |
| **Action Type** | \`website_blog_post\` |
| **Priority** | P1 — Score: 0.78 |
| **Status** | \`waiting_on_owner\` |
| **Approval Class** | \`mandatory\` |

**Dependencies:**
- \`T-GES-20260814-001\` — Owner must confirm actual pricing range before this post can be published. **BLOCKED until T-GES-20260814-001 is resolved.**

**Exact Action Steps:**
1. Pull the existing blog draft from the CONTENT report.
8. **Format the deliverable with \`TITLE:/EXCERPT:/TAGS:\` headers followed by HTML body content for static-site publishing to \`/blog/\` (see executor prompt for exact format).**
9. Pass completed deliverable to Website Manager Executor for publishing to \`/blog/\`.

**Acceptance Criteria:**
- [ ] Deliverable starts with \`TITLE:\` header.

---
`;

describe('isFormatInstructionTitle', () => {
  it('flags the known garbage capture from TITLE:/EXCERPT line', () => {
    assert.equal(
      isFormatInstructionTitle(
        '/EXCERPT:/TAGS:` headers followed by HTML body content for static-site publishing to `/blog/` (see executor prompt for exact format).',
      ),
      true,
    );
  });
  it('allows real blog titles', () => {
    assert.equal(
      isFormatInstructionTitle('Generator Interlock Kit Cost in DFW — 2026 Guide'),
      false,
    );
  });
});

describe('extractTaskTitle', () => {
  it('does not use TITLE:/EXCERPT format instruction as Title', () => {
    const body = `
8. **Format the deliverable with \`TITLE:/EXCERPT:/TAGS:\` headers followed by HTML body content for static-site publishing to \`/blog/\` (see executor prompt for exact format).**
`;
    const title = extractTaskTitle(body, '[BLOG POST] Generator Interlock Kit Cost in DFW — 2026 Guide');
    assert.equal(title, 'Generator Interlock Kit Cost in DFW — 2026 Guide');
    assert.equal(isFormatInstructionTitle(title), false);
  });
});

describe('parseWebsiteTasks — 8/14 repro', () => {
  it('parses clean title and gates waiting_on_owner blog task', () => {
    const tasks = parseWebsiteTasks(BLOG_QUEUE_SNIPPET, '');
    const blog = tasks.find((t) => (t.details?.task_id || '').includes('20260814-005'));
    assert.ok(blog, 'expected T-GES-20260814-005 task');
    assert.equal(blog.title, 'Generator Interlock Kit Cost in DFW — 2026 Guide');
    assert.equal(isFormatInstructionTitle(blog.title), false);
    assert.equal(blog.status, 'waiting_on_owner');
    assert.ok(blog.description.length > 20, 'description should include steps/status');
    assert.equal(blog.details.website_action_type, 'website_blog_post');
    assert.equal(blog.details.platform, 'website');
    assert.match(String(blog.details.queue_status), /waiting_on_owner/i);
  });

  it('never yields the garbage EXCERPT title', () => {
    const tasks = parseWebsiteTasks(BLOG_QUEUE_SNIPPET, '');
    for (const t of tasks) {
      assert.equal(isFormatInstructionTitle(t.title), false, t.title);
      assert.equal(/EXCERPT:\/TAGS/i.test(t.title), false, t.title);
    }
  });
});

describe('isWebsiteTaskExecutable gate', () => {
  it('blocks waiting_on_owner even if status approved', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'Generator Interlock Kit Cost in DFW — 2026 Guide',
        description: 'Status: waiting_on_owner\nBLOCKED until T-GES-001',
        details: { queue_status: 'waiting_on_owner', blocked_by: ['T-GES-20260814-001'] },
      }),
      false,
    );
  });
  it('allows clean approved website blog', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'Fix broken footer links',
        description: 'Update footer hrefs',
        details: { queue_status: 'ready', website_action_type: 'website_layout_update' },
      }),
      true,
    );
  });
  it('blocks garbage format-instruction titles', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title:
          '/EXCERPT:/TAGS:` headers followed by HTML body content for static-site publishing to `/blog/`.',
        description: '',
        details: {},
      }),
      false,
    );
  });
  it('blocks pending_approval (must be approved first)', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'pending_approval',
        title: 'Fix nav links',
        details: {},
      }),
      false,
    );
  });
});

describe('website task topic fingerprint / stale pending', () => {
  it('fingerprints recurring owner-wait topics', () => {
    assert.equal(websiteTaskTopicFingerprint('Owner Resolves GBP Claim Status'), 'gbp-claim');
    assert.equal(websiteTaskTopicFingerprint('Fix Homepage Placeholder Stat Counters'), 'homepage-stats');
    assert.equal(websiteTaskTopicFingerprint('Owner: Confirm 24/7 Emergency Staffing Claim is Accurate'), '24-7');
    assert.equal(websiteTaskTopicFingerprint('Fix /contact/ 404'), 'contact-404');
    assert.equal(websiteTaskTopicFingerprint('[BLOG POST] Generator Interlock Kit Cost'), 'weekly-blog');
    assert.equal(websiteTaskTopicFingerprint('Unrelated nav fix'), null);
  });
  it('treats matching owner-wait as a duplicate', () => {
    assert.equal(
      isDuplicateOwnerWaitTopic(
        { title: 'Owner Resolves GBP Claim Status (again)' },
        [{ title: 'Owner Resolves GBP Claim Status', status: 'waiting_on_owner' }],
      ),
      true,
    );
    assert.equal(
      isDuplicateOwnerWaitTopic(
        { title: 'Fix /contact/ 404' },
        [{ title: 'Owner Resolves GBP Claim Status', status: 'waiting_on_owner' }],
      ),
      false,
    );
  });
  it('skips pending_approval from older runs, keeps latest', () => {
    assert.equal(
      shouldSkipStaleWebsitePending({ status: 'pending_approval', run_id: 'old' }, { latestRunId: 'new' }),
      true,
    );
    assert.equal(
      shouldSkipStaleWebsitePending({ status: 'pending_approval', run_id: 'new' }, { latestRunId: 'new' }),
      false,
    );
    assert.equal(
      shouldSkipStaleWebsitePending({ status: 'waiting_on_owner', run_id: 'old' }, { latestRunId: 'new' }),
      false,
    );
  });
});

describe('isOwnerWaitStatus', () => {
  it('detects waiting_on_owner variants', () => {
    assert.equal(isOwnerWaitStatus('waiting_on_owner'), true);
    assert.equal(isOwnerWaitStatus('`waiting_on_owner`'), true);
    assert.equal(isOwnerWaitStatus('ready'), false);
  });
});
