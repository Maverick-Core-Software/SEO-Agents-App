#!/usr/bin/env node
/**
 * gbp-media-sync.mjs
 * Google Business Profile Job-Site Photo Upload Engine.
 * Uploads photos directly to Grizzly Electrical Solutions' GBP gallery.
 *
 * Usage:
 *   node gbp-media-sync.mjs --photoUrl <url> --category <AT_WORK|EXTERIOR|INTERIOR> [--dry-run]
 */

import path from 'node:path';
import process from 'node:process';
import { gbpFetch } from './lib/gbp-api-auth.mjs';

export async function uploadGbpPhoto(photoUrl, category = 'AT_WORK', options = {}) {
  const { dryRun = false } = options;

  console.log(`[GBP-MEDIA] Preparing photo upload (${category}): ${photoUrl}`);

  if (dryRun) {
    console.log('[GBP-MEDIA] Dry-run enabled — returning simulated success.');
    return { status: 'DRY_RUN_SUCCESS', category, photoUrl };
  }

  const data = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const accounts = data.accounts || [];
  if (!accounts.length) throw new Error('No GBP accounts found.');

  const accountName = accounts[0].name;
  const locationsData = await gbpFetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`);
  const locations = locationsData.locations || [];
  if (!locations.length) throw new Error('No GBP locations found.');

  const locationName = locations[0].name; // locations/123
  const endpoint = `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}/media`;

  const requestBody = {
    mediaFormat: 'PHOTO',
    locationAssociation: { category: category },
    sourceUrl: photoUrl
  };

  console.log(`[GBP-MEDIA] Uploading photo to ${endpoint}...`);
  const result = await gbpFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(requestBody)
  });

  console.log(`[GBP-MEDIA] ✅ Photo uploaded successfully: ${result.name || 'OK'}`);
  return result;
}

// CLI Execution
if (process.argv[1] && path.basename(process.argv[1]) === 'gbp-media-sync.mjs') {
  const args = process.argv.slice(2);
  let photoUrl = null;
  let category = 'AT_WORK';
  let dryRun = args.includes('--dry-run');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--photoUrl' && args[i + 1]) photoUrl = args[i + 1];
    if (args[i] === '--category' && args[i + 1]) category = args[i + 1];
  }

  if (!photoUrl) {
    console.log('Usage: node gbp-media-sync.mjs --photoUrl <url> [--category AT_WORK] [--dry-run]');
    process.exit(0);
  }

  uploadGbpPhoto(photoUrl, category, { dryRun })
    .then((res) => console.log('Result:', res))
    .catch((err) => console.error('Error uploading photo:', err.message));
}
