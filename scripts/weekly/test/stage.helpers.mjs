// scripts/weekly/test/stage.helpers.mjs
// Shared builders for the stage group's tests (not a test file itself).
import { weekSpecForWeekOf } from '../lib/week-spec.mjs';

export const NOW = new Date('2026-09-04T21:00:00.000Z');
export const ISO = NOW.toISOString();
export const WEEK = weekSpecForWeekOf('2026-09-07', NOW);
export const ATTEMPT_ID = '2026-09-07-20260904T210000Z-abc123';
export const SERVICES = ['Electrical Panel Upgrade / Replacement', 'EV Charger Installation', 'Electrical Troubleshooting & Repair'];

function gbpItem(day, service) {
  return {
    day, date: WEEK.gbp_dates[day], service, topic: `Topic ${day}`, trend_tie: 'Fall loads',
    headline: `Headline ${day} in Rockwall`, body: `Body ${day} for Rockwall homeowners. Text (469) 896-3862 for a quote.`,
    caption: `Caption ${day}`, photo_file: day % 2 ? `IMG_${2700 + day}.JPG` : null, cta: 'Text us a photo',
    hashtags: ['#RockwallElectrician', '#PanelUpgrade', '#DFWElectrician'], status: 'Needs approval',
  };
}

function fbItem(day, type, service, boost) {
  return {
    day, date: WEEK.fb_dates[day], type, service, post_goal: 'education', format: 'Educational',
    hook: `Hook ${day}`, body: `Body ${day} with thirty or so words about ${service} for Rockwall homeowners who want a straight answer from a local electrician this week.`,
    cta: 'Drop a comment', hashtags: ['#DFWElectrician'], contact: 'Text (469) 896-3862', photo_file: type === 'text' ? null : `IMG_${3400 + day}.JPG`,
    video_prompt: '', on_screen_text: 'Panel check', boost, boost_targeting: '15mi radius from Rowlett',
  };
}

/** A schema-valid plan for week 2026-09-07 (GBP starts Friday 2026-09-04). */
export function makePlan(overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    week_of: '2026-09-07',
    topic: { service_key: 'panel_upgrade', service_label: SERVICES[0], city: 'Rockwall', query_family: ['electrical panel upgrade rockwall'] },
    gbp: [1, 2, 3, 4, 5, 6, 7].map((d) => gbpItem(d, SERVICES[(d - 1) % 3])),
    facebook: [
      fbItem(1, 'slideshow', SERVICES[0], { decision: 'YES', daily_usd: 25, days: 1 }),
      fbItem(3, 'carousel', SERVICES[1], { decision: 'YES', daily_usd: 25, days: 1 }),
      fbItem(5, 'photo', SERVICES[2], { decision: 'NO', daily_usd: null, days: null }),
      fbItem(6, 'text', SERVICES[0], { decision: 'MAYBE', daily_usd: null, days: null }),
    ],
    website_actions: [
      { type: 'website_service_page_update', title: 'Refresh panel page', target: '/panel-upgrades/', priority: 'high', description: 'Add Rockwall section', owner_gate: false, draft: null, source_ids: ['obs-1'] },
      { type: 'website_blog_post', title: 'Panel upgrade cost in Rockwall', target: '', priority: 'medium', description: 'New post', owner_gate: true, draft: { title: 'T', meta_description: 'M', html: '<p>x</p>' }, source_ids: [] },
    ],
    notes: { trend_signals: ['fall loads'], photo_gaps: [], degraded: false, degraded_reason: null },
    ...overrides,
  };
}
