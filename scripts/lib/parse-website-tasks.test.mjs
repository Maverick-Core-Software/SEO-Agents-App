/**
 * node --test scripts/lib/parse-website-tasks.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFormatInstructionTitle,
  isOwnerWaitStatus,
  isOwnerGatedDescription,
  websiteTaskBlockReason,
  isWebsiteTaskExecutable,
  extractTaskTitle,
  parseWebsiteTasks,
  websiteTaskTopicFingerprint,
  isDuplicateOwnerWaitTopic,
  shouldSkipStaleWebsitePending,
} from './parse-website-tasks.mjs';

const FINAL_REPORT_OWNER_GATED = `
## Incomplete

| Task ID | Task | What was missing | Recommended Next Step |
|---|---|---|---|
| T-101 | Update Hours on Homepage | Holiday hours not reflected | Owner must confirm holiday hours before publishing |
| T-102 | Fix FAQ Schema | Schema missing on FAQ page | Add FAQPage JSON-LD to the FAQ template |

### Task 3: Rewrite Services Copy

**Task ID:** \`T-103\`
**What was missing:** Outdated service descriptions
**Recommended Next Step:** Awaiting owner confirmation of the new service list

### Task 4: Fix Broken Gallery Link

**Task ID:** \`T-104\`
**What was missing:** Gallery link 404s
**Recommended Next Step:** Point the gallery link at the new /gallery/ path

### T-GES-20260831-001 — BLOCKED

**Title:** Verify Site Backend Access

**Blocker:** Owner has not provided access to the site backend.
**Recommended Next Step:** Owner must share hosting credentials.

### T-GES-20260831-002 — PARTIAL

**Title:** Finish Hero Section Copy

**Blocker:** Ran out of time mid-edit.
**Recommended Next Step:** Finish the remaining section edits.
`;

const FINAL_REPORT_TABLE = `
## Incomplete

| Task ID | Task | What was missing | Recommended Next Step |
|---|---|---|---|
| T-201 | Fix Nav Highlight | Nav state broken | Restore active-nav styling |
`;

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

describe('parseWebsiteTasks — final_report owner-gated rows', () => {
  it('marks owner-confirmation and blocker rows waiting_on_owner, never pending', () => {
    const tasks = parseWebsiteTasks('', FINAL_REPORT_OWNER_GATED);
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t.status]));
    assert.equal(byTitle['Update Hours on Homepage'], 'waiting_on_owner', 'next step demands owner confirmation');
    assert.equal(byTitle['Rewrite Services Copy'], 'waiting_on_owner', 'awaiting owner confirmation');
    assert.equal(byTitle['Verify Site Backend Access'], 'waiting_on_owner', 'BLOCKED header + Blocker field');
    assert.equal(byTitle['Finish Hero Section Copy'], 'waiting_on_owner', 'Blocker field present');
    assert.equal(byTitle['Fix FAQ Schema'], 'pending_approval', 'clean next step stays pending');
    assert.equal(byTitle['Fix Broken Gallery Link'], 'pending_approval', 'clean next step stays pending');
  });
  it('keeps a clean Incomplete table row pending_approval', () => {
    const tasks = parseWebsiteTasks('', FINAL_REPORT_TABLE);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Fix Nav Highlight');
    assert.equal(tasks[0].status, 'pending_approval');
  });
});

describe('isOwnerGatedDescription', () => {
  it('detects owner-confirmation and blocker content', () => {
    assert.equal(isOwnerGatedDescription('Owner must confirm actual pricing range before publishing.'), true);
    assert.equal(isOwnerGatedDescription('Awaiting owner approval of the copy.'), true);
    assert.equal(isOwnerGatedDescription('Waiting on owner to provide access.'), true);
    assert.equal(isOwnerGatedDescription('Waiting for owner approval of the copy.'), true);
    assert.equal(isOwnerGatedDescription('Owner to confirm the final service list.'), true);
    assert.equal(isOwnerGatedDescription('Confirm with owner before publishing.'), true);
    assert.equal(isOwnerGatedDescription('Needs owner input on the FAQ answers.'), true);
    assert.equal(isOwnerGatedDescription('Blocker: Owner has not provided the new phone number.'), true);
    assert.equal(isOwnerGatedDescription('BLOCKED until T-GES-20260814-001 is resolved.'), true);
    assert.equal(isOwnerGatedDescription('Status: Blocked on the owner review.'), true);
  });
  it('does not flag plain prose or incidental words', () => {
    assert.equal(isOwnerGatedDescription('Update the footer with the new service list.'), false);
    assert.equal(isOwnerGatedDescription('Fix the blocked form submission on the contact page.'), false);
    assert.equal(isOwnerGatedDescription('Add FAQ schema markup to the homepage.'), false);
    assert.equal(isOwnerGatedDescription(''), false);
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
  it('blocks owner-gated descriptions even when approved', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'Update Hours',
        description: 'Owner must confirm holiday hours before publishing.',
        details: { platform: 'website' },
      }),
      false,
    );
  });
  it('blocks unsupported platforms without claiming them', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'GBP listing',
        description: 'Verify listing',
        details: { platform: 'gbp' },
      }),
      false,
    );
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'T',
        description: 'D',
        details: { platform: 'social' },
      }),
      false,
    );
  });
  it('allows website platform and legacy null platform', () => {
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'T',
        description: 'D',
        details: { platform: 'website' },
      }),
      true,
    );
    assert.equal(
      isWebsiteTaskExecutable({
        status: 'approved',
        title: 'T',
        description: 'D',
        details: {},
      }),
      true,
    );
  });
  it('websiteTaskBlockReason explains the gate for parking', () => {
    assert.match(websiteTaskBlockReason({ status: 'approved', title: 'T', description: 'Owner must confirm pricing.', details: {} }), /owner-gated/);
    assert.match(websiteTaskBlockReason({ status: 'approved', title: 'T', description: 'D', details: { platform: 'social' } }), /unsupported platform=social/);
    assert.match(websiteTaskBlockReason({ status: 'pending_approval', title: 'T', description: 'D', details: {} }), /status=pending_approval/);
    assert.equal(websiteTaskBlockReason({ status: 'approved', title: 'T', description: 'D', details: { platform: 'website' } }), null);
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
