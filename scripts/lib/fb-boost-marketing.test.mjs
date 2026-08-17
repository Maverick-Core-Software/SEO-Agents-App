import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBoostPlan,
  buildTargeting,
  captionMatchTokens,
  dollarsToMinor,
  normalizeAdAccountId,
  objectStoryId,
  parseAgesFromTargeting,
  readBoostConfig,
  scoreLivePosts,
  centralDateFromIso,
} from './fb-boost-marketing.mjs';

test('dollarsToMinor converts USD to cents', () => {
  assert.equal(dollarsToMinor(25), 2500);
  assert.equal(dollarsToMinor(25.5), 2550);
  assert.throws(() => dollarsToMinor(0));
});

test('normalizeAdAccountId adds act_ prefix once', () => {
  assert.equal(normalizeAdAccountId('123'), 'act_123');
  assert.equal(normalizeAdAccountId('act_123'), 'act_123');
  assert.equal(normalizeAdAccountId(''), '');
});

test('objectStoryId composes page and post ids', () => {
  assert.equal(objectStoryId('108', '999'), '108_999');
  assert.equal(objectStoryId('108', '108_999'), '108_999');
});

test('parseAgesFromTargeting reads en-dash ranges', () => {
  assert.deepEqual(parseAgesFromTargeting('15mi Dallas, homeowners 28–65'), { min: 28, max: 65 });
  assert.deepEqual(parseAgesFromTargeting('no ages here', { min: 30, max: 55 }), { min: 30, max: 55 });
});

test('scoreLivePosts prefers same-day caption match', () => {
  const pageId = '108252941997164';
  const posts = [
    {
      id: `${pageId}_aaa`,
      created_time: '2026-08-17T14:39:17+0000',
      message: 'Your AC shouldn\'t make the lights dim every time it kicks on. panel upgrade.',
    },
    {
      id: `${pageId}_bbb`,
      created_time: '2026-08-14T17:10:36+0000',
      message: 'A DFW homeowner texted us a photo of their panel.',
    },
  ];
  const scored = scoreLivePosts(posts, {
    pickDate: '2026-08-17',
    tokens: ['panel', 'lights', 'upgrade'],
    pageId,
  });
  assert.equal(scored[0].post.id, `${pageId}_aaa`);
  assert.ok(scored[0].score >= 100);
});

test('buildTargeting pins Dallas radius and optional interests', () => {
  const t = buildTargeting({ interestIds: ['6001'], excludeInterestIds: ['6002'] });
  assert.equal(t.geo_locations.custom_locations[0].radius, 20);
  assert.equal(t.geo_locations.custom_locations[0].latitude, 32.7767);
  assert.equal(t.flexible_spec[0].interests[0].id, '6001');
  assert.equal(t.exclusions.interests[0].id, '6002');
});

test('buildBoostPlan produces minor-unit budget and object_story_id', () => {
  const plan = buildBoostPlan({
    week: '2026-08-17',
    pick: { key: 'day1-panel-upgrade', daily: 25, days: 2 },
    pageId: '108',
    postId: '108_999',
    ages: { min: 28, max: 65 },
    now: new Date('2026-08-17T15:00:00Z'),
  });
  assert.equal(plan.daily_budget_minor, 2500);
  assert.equal(plan.object_story_id, '108_999');
  assert.equal(plan.optimization_goal, 'POST_ENGAGEMENT');
  assert.ok(plan.end_time > plan.start_time);
});

test('readBoostConfig reports missing ad account', () => {
  const cfg = readBoostConfig({
    FB_PAGE_ID: '1',
    FB_PAGE_ACCESS_TOKEN: 'tok',
  });
  assert.equal(cfg.ready, false);
  assert.ok(cfg.missing.includes('FB_AD_ACCOUNT_ID'));
  assert.equal(cfg.enabled, false);
});

test('readBoostConfig ready when account + token + page present', () => {
  const cfg = readBoostConfig({
    FB_PAGE_ID: '1',
    FB_ADS_ACCESS_TOKEN: 'tok',
    FB_AD_ACCOUNT_ID: 'act_99',
    FB_BOOST_API: '1',
  });
  assert.equal(cfg.ready, true);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.adAccountId, 'act_99');
});

test('captionMatchTokens pulls service words', () => {
  const tokens = captionMatchTokens({ service: 'Panel Upgrade' }, '**HOOK:**\nLights dim when AC starts\n');
  assert.ok(tokens.includes('panel') || tokens.includes('upgrade') || tokens.includes('lights'));
});

test('centralDateFromIso returns YYYY-MM-DD in Chicago', () => {
  // 2026-08-17T14:39Z is mid-morning CT
  const d = centralDateFromIso('2026-08-17T14:39:17+0000');
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d, '2026-08-17');
});
