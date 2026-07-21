import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_PAGE_METRICS = [
  'page_post_engagements',
  'page_media_view',
  'page_follows',
  'page_views_total',
];

export const DEFAULT_POST_METRICS = [
  'post_activity_by_action_type',
  'post_clicks',
  'post_media_view',
  'post_reactions_by_type_total',
];

export function loadProjectEnv(projectRoot) {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function normalizeMetricValue(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + (typeof item === 'number' ? item : 0), 0);
  }
  return 0;
}

function insightValues(data = []) {
  return Object.fromEntries(data.map((entry) => [
    entry.name,
    (entry.values || []).map((value) => ({
      end_time: value.end_time || null,
      value: value.value,
      numeric_value: normalizeMetricValue(value.value),
    })),
  ]));
}

function firstInsightValue(insights, metric) {
  return insights?.[metric]?.[0]?.numeric_value ?? 0;
}

function postKind(post) {
  const attachment = post.attachments?.data?.[0] || {};
  return attachment.media_type || attachment.type || 'text';
}

export function summarizePost(post, insightData) {
  const insights = insightValues(insightData);
  const unavailableMetrics = Object.fromEntries(insightData
    .filter((entry) => entry.unavailable)
    .map((entry) => [entry.name, entry.unavailable]));
  const reactions = firstInsightValue(insights, 'post_reactions_by_type_total');
  const comments = Number(post.comments?.summary?.total_count || 0);
  const shares = Number(post.shares?.count || 0);
  const clicks = firstInsightValue(insights, 'post_clicks');
  const mediaViews = firstInsightValue(insights, 'post_media_view');
  const interactions = reactions + comments + shares + clicks;
  return {
    id: post.id,
    created_time: post.created_time || null,
    permalink_url: post.permalink_url || null,
    message: post.message || '',
    media_type: postKind(post),
    media_views: mediaViews,
    clicks,
    reactions,
    comments,
    shares,
    interactions,
    engagement_rate: null,
    insights,
    unavailable_metrics: unavailableMetrics,
  };
}

export function rankPosts(posts) {
  return [...posts].sort((a, b) => (
    b.interactions - a.interactions
    || b.clicks - a.clicks
    || b.media_views - a.media_views
  ));
}

export function contentRecommendations(posts) {
  if (!posts.length) return { recommendations: [], evidence: [], caveat: 'No posts were returned for the selected period.' };
  const ranked = rankPosts(posts);
  const winners = ranked.slice(0, Math.min(5, ranked.length));
  const byMedia = new Map();
  for (const post of posts) {
    const bucket = byMedia.get(post.media_type) || { count: 0, interactions: 0 };
    bucket.count += 1;
    bucket.interactions += post.interactions;
    byMedia.set(post.media_type, bucket);
  }
  const media = [...byMedia.entries()].map(([type, stats]) => ({
    media_type: type,
    posts: stats.count,
    average_interactions: Number((stats.interactions / stats.count).toFixed(2)),
    interactions: stats.interactions,
  })).sort((a, b) => b.average_interactions - a.average_interactions);
  const best = media[0];
  const recommendations = [];
  if (best) recommendations.push({
    action: `Prioritize ${best.media_type} posts in the next content batch.`,
    rationale: `${best.media_type} averaged ${best.average_interactions} observed interaction(s) across ${best.posts} sampled post(s).`,
    confidence: best.posts >= 3 ? 'medium' : 'low',
  });
  const winnerMessages = winners.filter((post) => post.message).map((post) => post.message.slice(0, 180));
  if (winnerMessages.length) recommendations.push({
    action: 'Reuse the problem-first hooks and service topics from the winning posts, then vary the visual and CTA.',
    rationale: 'The highest-engagement posts are included as evidence below for agent review.',
    confidence: winners.length >= 3 ? 'medium' : 'low',
  });
  return {
    recommendations,
    evidence: { top_posts: winners, media_type_comparison: media },
    caveat: 'This is descriptive, not causal. Compare like-for-like topics and post times before changing the content mix materially.',
  };
}

export function createFacebookClient({ pageId, accessToken, apiVersion = 'v22.0', fetchImpl = fetch }) {
  if (!pageId) throw new Error('FB_PAGE_ID is not set. Add it to the SEO-Agents-App .env file.');
  if (!accessToken) throw new Error('FB_PAGE_ACCESS_TOKEN is not set. Add it to the SEO-Agents-App .env file.');
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  async function get(node, params = {}) {
    const url = new URL(`${baseUrl}/${String(node).replace(/^\//, '')}`);
    for (const [key, value] of Object.entries({ ...params, access_token: accessToken })) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url);
    const payload = await response.json();
    if (!response.ok || payload.error) {
      const error = payload.error || {};
      throw new Error(`Meta Graph API request to /${node} failed${error.code ? ` (#${error.code})` : ''}: ${error.message || response.statusText}`);
    }
    return payload;
  }

  async function pageOverview({ days = 28, metrics = DEFAULT_PAGE_METRICS } = {}) {
    const since = dateDaysAgo(days);
    const page = await get(pageId, { fields: 'id,name,link,fan_count,followers_count' });
    const metricResults = await Promise.all(metrics.map(async (metric) => {
      try {
        const data = await get(`${pageId}/insights`, { metric, period: 'day', since, until: dateDaysAgo(0) });
        return { metric, available: true, values: insightValues(data.data)[metric] || [] };
      } catch (error) {
        return { metric, available: false, error: error.message };
      }
    }));
    return { page, period: { since, until: dateDaysAgo(0), days }, metrics: metricResults };
  }

  async function postInsights(post) {
    const results = await Promise.all(DEFAULT_POST_METRICS.map(async (metric) => {
      try {
        const data = await get(`${post.id}/insights`, { metric, period: 'lifetime' });
        return data.data || [];
      } catch (error) {
        return [{ name: metric, values: [], unavailable: error.message }];
      }
    }));
    return results.flat();
  }

  async function topPosts({ limit = 10 } = {}) {
    const feed = await get(`${pageId}/posts`, {
      fields: 'id,message,created_time,permalink_url,attachments{media_type,type},comments.limit(0).summary(true),reactions.limit(0).summary(true),shares',
      limit: Math.min(Math.max(limit, 1), 25),
    });
    const posts = [];
    for (const post of feed.data || []) posts.push(summarizePost(post, await postInsights(post)));
    return { sampled_posts: posts.length, posts: rankPosts(posts) };
  }

  async function postPerformance({ postId }) {
    const post = await get(postId, {
      fields: 'id,message,created_time,permalink_url,attachments{media_type,type},comments.limit(0).summary(true),reactions.limit(0).summary(true),shares',
    });
    return summarizePost(post, await postInsights(post));
  }

  async function recentComments({ limit = 20 } = {}) {
    const feed = await get(`${pageId}/posts`, { fields: 'id,message,created_time,permalink_url', limit: 10 });
    const comments = [];
    for (const post of feed.data || []) {
      const result = await get(`${post.id}/comments`, { fields: 'id,from,message,created_time,like_count,comment_count,permalink_url', order: 'reverse_chronological', limit: Math.min(limit, 100) });
      for (const comment of result.data || []) comments.push({ post: { id: post.id, permalink_url: post.permalink_url, message: post.message || '' }, ...comment });
    }
    return comments.sort((a, b) => new Date(b.created_time) - new Date(a.created_time)).slice(0, limit);
  }

  async function inbox({ limit = 20, includeMessages = false } = {}) {
    const conversations = await get(`${pageId}/conversations`, {
      fields: 'id,updated_time,unread_count,message_count,participants,can_reply',
      limit: Math.min(limit, 100),
    });
    const results = [];
    for (const conversation of conversations.data || []) {
      const item = { ...conversation };
      if (includeMessages) {
        const messages = await get(`${conversation.id}/messages`, { fields: 'id,from,message,created_time', limit: 5 });
        item.messages = messages.data || [];
      }
      results.push(item);
    }
    return { conversations: results, note: 'Read-only tool. No replies are sent.' };
  }

  return { pageOverview, topPosts, postPerformance, recentComments, inbox };
}
