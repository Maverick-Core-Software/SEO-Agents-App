#!/usr/bin/env node
/**
 * Read-only Facebook Page analytics and inbox MCP server.
 *
 * Credentials stay in the SEO-Agents-App .env file. This server never publishes,
 * replies, edits posts, or changes Page state.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DEFAULT_PAGE_METRICS,
  contentRecommendations,
  createFacebookClient,
  loadProjectEnv,
} from './lib/facebook-insights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
loadProjectEnv(projectRoot);

const client = createFacebookClient({
  pageId: process.env.FB_PAGE_ID,
  accessToken: process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN,
  apiVersion: process.env.FB_GRAPH_API_VERSION || 'v22.0',
});

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'facebook-page-insights', version: '1.0.0' });

server.tool(
  'facebook_page_overview',
  'Read Page-level performance totals over a date range. Use this for reach, views/impressions, engagement, and follower trends.',
  {
    days: z.number().int().min(1).max(365).default(28).describe('Number of days to review.'),
    metrics: z.array(z.string()).min(1).max(10).default(DEFAULT_PAGE_METRICS).describe('Optional Meta Page Insights metric names.'),
  },
  async (input) => result(await client.pageOverview(input)),
);

server.tool(
  'facebook_top_posts',
  'Rank recently published Page posts by observed interactions, clicks, media views, reactions, comments, and shares. Results include unavailable metrics rather than inventing values.',
  { limit: z.number().int().min(1).max(25).default(10).describe('How many recent posts to analyze.') },
  async (input) => result(await client.topPosts(input)),
);

server.tool(
  'facebook_post_performance',
  'Inspect available lifetime metrics for one Facebook post ID, including clicks, media views, reactions, comments, and shares. Metrics Meta does not expose are reported as unavailable.',
  { post_id: z.string().min(1).describe('Facebook post object ID, typically returned by facebook_top_posts.') },
  async ({ post_id: postId }) => result(await client.postPerformance({ postId })),
);

server.tool(
  'facebook_content_recommendations',
  'Analyze a sample of recent posts and return evidence-backed content-format recommendations. This is read-only and does not create or schedule posts.',
  { limit: z.number().int().min(3).max(25).default(12).describe('How many recent posts to use as the sample.') },
  async ({ limit }) => {
    const analysis = await client.topPosts({ limit });
    return result({ sampled_posts: analysis.sampled_posts, ...contentRecommendations(analysis.posts) });
  },
);

server.tool(
  'facebook_recent_comments',
  'Read recent comments across the Page’s latest posts. Use it to find quote requests, unanswered questions, service concerns, and engagement opportunities. Does not reply or moderate.',
  { limit: z.number().int().min(1).max(100).default(20).describe('Maximum recent comments to return.') },
  async (input) => result(await client.recentComments(input)),
);

server.tool(
  'facebook_inbox',
  'Read Page conversation metadata and optionally the last five messages in each conversation. This never sends a reply.',
  {
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum conversations to return.'),
    include_messages: z.boolean().default(false).describe('Include the latest five message bodies per conversation.'),
  },
  async ({ include_messages: includeMessages, ...input }) => result(await client.inbox({ ...input, includeMessages })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
