#!/usr/bin/env node
/**
 * gbp-analytics-collector.mjs
 * Pulls real-time performance analytics from Google Business Profile Performance API.
 * Output is saved to outputs/gbp-analytics-latest.json for SEO strategy optimization.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gbpFetch } from './lib/gbp-api-auth.mjs';

const OUTPUT_FILE = path.join(process.cwd(), 'outputs', 'gbp-analytics-latest.json');

export async function fetchGbpAnalytics(options = {}) {
  const { days = 30 } = options;

  console.log('[GBP-ANALYTICS] Fetching account and location details...');
  const data = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const accounts = data.accounts || [];
  if (!accounts.length) {
    throw new Error('No Google Business Profile accounts found.');
  }

  const accountId = accounts[0].name;
  const locationsData = await gbpFetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title`);
  const locations = locationsData.locations || [];
  if (!locations.length) {
    throw new Error(`No locations found for account: ${accountId}`);
  }

  const locationId = locations[0].name; // format: locations/12345
  console.log(`[GBP-ANALYTICS] Location found: ${locationId} (${locations[0].title})`);

  // Define date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

  const formatDate = (d) => ({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate()
  });

  const metrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'BUSINESS_CALLS',
    'BUSINESS_DIRECTION_REQUESTS',
    'BUSINESS_WEBSITE_CLICKS'
  ];

  const endpoint = `https://mybusinessperformance.googleapis.com/v1/${locationId}:fetchMultiDailyMetricsTimeSeries`;
  
  console.log(`[GBP-ANALYTICS] Pulling ${days}-day performance time series...`);
  const analyticsData = await gbpFetch(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const outputPayload = {
    updated_at: new Date().toISOString(),
    location: locations[0].title,
    location_id: locationId,
    date_range: { start: startDate.toISOString(), end: endDate.toISOString() },
    metrics: analyticsData
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputPayload, null, 2), 'utf-8');

  console.log(`[GBP-ANALYTICS] ✅ Successfully saved analytics to: ${OUTPUT_FILE}`);
  return outputPayload;
}

// CLI Execution
if (process.argv[1] && path.basename(process.argv[1]) === 'gbp-analytics-collector.mjs') {
  fetchGbpAnalytics({ days: 30 })
    .then((res) => console.log('Analytics Summary:', JSON.stringify(res, null, 2)))
    .catch((err) => console.error('Error fetching GBP analytics:', err.message));
}
