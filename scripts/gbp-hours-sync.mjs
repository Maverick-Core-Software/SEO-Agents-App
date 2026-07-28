#!/usr/bin/env node
/**
 * gbp-hours-sync.mjs
 * Special & Holiday Hours Management Engine for Grizzly Electrical Solutions.
 * Updates business hours and special holiday hours via Google Business Profile API.
 *
 * Usage:
 *   node gbp-hours-sync.mjs --specialHours <json> [--dry-run]
 */

import path from 'node:path';
import process from 'node:process';
import { gbpFetch } from './lib/gbp-api-auth.mjs';

export async function updateSpecialHours(specialHoursArray, options = {}) {
  const { dryRun = false } = options;

  console.log(`[GBP-HOURS] Updating special hours (${specialHoursArray.length} date entries)...`);

  if (dryRun) {
    console.log('[GBP-HOURS] Dry-run enabled — returning simulated success.');
    return { status: 'DRY_RUN_SUCCESS', specialHours: specialHoursArray };
  }

  const data = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const accounts = data.accounts || [];
  if (!accounts.length) throw new Error('No GBP accounts found.');

  const accountName = accounts[0].name;
  const locationsData = await gbpFetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,specialHours`);
  const locations = locationsData.locations || [];
  if (!locations.length) throw new Error('No GBP locations found.');

  const locationName = locations[0].name; // locations/123
  const endpoint = `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?updateMask=specialHours`;

  const requestBody = {
    name: locationName,
    specialHours: {
      specialHourPeriods: specialHoursArray
    }
  };

  console.log(`[GBP-HOURS] Updating special hours at ${endpoint}...`);
  const result = await gbpFetch(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(requestBody)
  });

  console.log(`[GBP-HOURS] ✅ Special hours updated successfully for ${locations[0].title}`);
  return result;
}

// CLI Execution
if (process.argv[1] && path.basename(process.argv[1]) === 'gbp-hours-sync.mjs') {
  const args = process.argv.slice(2);
  let specialHours = null;
  let dryRun = args.includes('--dry-run');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--specialHours' && args[i + 1]) {
      try {
        specialHours = JSON.parse(args[i + 1]);
      } catch (e) {
        console.error('Invalid JSON for --specialHours:', e.message);
        process.exit(1);
      }
    }
  }

  if (!specialHours) {
    console.log('Usage: node gbp-hours-sync.mjs --specialHours <json> [--dry-run]');
    process.exit(0);
  }

  updateSpecialHours(specialHours, { dryRun })
    .then((res) => console.log('Result:', res))
    .catch((err) => console.error('Error updating special hours:', err.message));
}
