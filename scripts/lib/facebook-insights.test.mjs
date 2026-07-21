import assert from 'node:assert/strict';
import test from 'node:test';
import { contentRecommendations, rankPosts, summarizePost } from './facebook-insights.mjs';

test('summarizePost derives observed post metrics from Graph payloads', () => {
  const post = {
    id: '123_456', message: 'Panel upgrade before/after', created_time: '2026-07-10T12:00:00+0000',
    comments: { summary: { total_count: 3 } }, shares: { count: 2 }, attachments: { data: [{ media_type: 'video' }] },
  };
  const metrics = [
    { name: 'post_clicks', values: [{ value: 8 }] },
    { name: 'post_media_view', values: [{ value: 100 }] },
    { name: 'post_reactions_by_type_total', values: [{ value: { like: 10, love: 2 } }] },
  ];
  const result = summarizePost(post, metrics);
  assert.equal(result.media_views, 100);
  assert.equal(result.reactions, 12);
  assert.equal(result.interactions, 25);
  assert.equal(result.engagement_rate, null);
  assert.equal(result.media_type, 'video');
});

test('rankPosts prioritizes observed interactions then click volume', () => {
  const posts = rankPosts([
    { id: 'lower', interactions: 30, clicks: 9, media_views: 300 },
    { id: 'higher', interactions: 80, clicks: 4, media_views: 2000 },
  ]);
  assert.deepEqual(posts.map((post) => post.id), ['higher', 'lower']);
});

test('contentRecommendations labels small samples as low confidence', () => {
  const result = contentRecommendations([
    { id: '1', media_type: 'video', engagement_rate: 11, interactions: 40, message: 'Video hook' },
    { id: '2', media_type: 'photo', engagement_rate: 4, interactions: 20, message: 'Photo hook' },
  ]);
  assert.equal(result.recommendations[0].confidence, 'low');
  assert.match(result.recommendations[0].action, /video/);
});
