#!/usr/bin/env node
/**
 * gbp-review-agent.mjs
 * Automated Review Response & Reputation Agent for Grizzly Electrical Solutions.
 * Checks for unreplied reviews, auto-posts thank-you replies for 4-5★ reviews,
 * and triggers alerts for 1-3★ reviews.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gbpFetch } from './lib/gbp-api-auth.mjs';

export async function processReviews(options = {}) {
  const { dryRun = false } = options;

  console.log('[GBP-REVIEWS] Fetching Google Business Profile accounts...');
  const data = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const accounts = data.accounts || [];
  if (!accounts.length) throw new Error('No GBP accounts found.');

  const accountName = accounts[0].name;
  const locationsData = await gbpFetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`);
  const locations = locationsData.locations || [];
  if (!locations.length) throw new Error('No GBP locations found.');

  const locationName = locations[0].name; // format: locations/123
  console.log(`[GBP-REVIEWS] Polling reviews for location: ${locationName}...`);

  const reviewsData = await gbpFetch(`https://mybusinessreviews.googleapis.com/v1/${locationName}/reviews`);
  const reviews = reviewsData.reviews || [];
  console.log(`[GBP-REVIEWS] Found ${reviews.length} total reviews.`);

  let repliedCount = 0;
  let alertCount = 0;

  for (const r of reviews) {
    const starRating = r.starRating; // 'FIVE', 'FOUR', 'THREE', 'TWO', 'ONE'
    const comment = r.comment || '';
    const reviewerName = r.reviewer?.displayName || 'Valued Customer';
    const reviewId = r.name; // format: locations/123/reviews/456

    if (r.reviewReply) {
      // Already replied
      continue;
    }

    if (starRating === 'FIVE' || starRating === 'FOUR') {
      const replyText = `Thank you so much, ${reviewerName}, for choosing Grizzly Electrical Solutions! We truly appreciate your feedback and look forward to helping you with any future electrical needs in Texas.`;
      
      console.log(`[GBP-REVIEWS] Drafting reply for ${starRating} review by ${reviewerName}...`);
      if (!dryRun) {
        await gbpFetch(`https://mybusinessreviews.googleapis.com/v1/${reviewId}/reply`, {
          method: 'PUT',
          body: JSON.stringify({ comment: replyText })
        });
        console.log(`[GBP-REVIEWS] ✅ Replied successfully to review ${reviewId}`);
      } else {
        console.log(`[GBP-REVIEWS] (Dry-run) Would reply: "${replyText}"`);
      }
      repliedCount++;
    } else if (['ONE', 'TWO', 'THREE'].includes(starRating)) {
      console.warn(`[GBP-REVIEWS] ⚠️ LOW RATING DETECTED (${starRating}) from ${reviewerName}: "${comment}"`);
      alertCount++;
    }
  }

  return { totalReviews: reviews.length, repliedCount, alertCount };
}

// CLI Execution
if (process.argv[1] && path.basename(process.argv[1]) === 'gbp-review-agent.mjs') {
  const dryRun = process.argv.includes('--dry-run');
  processReviews({ dryRun })
    .then((res) => console.log('Review Processing Summary:', res))
    .catch((err) => console.error('Error processing GBP reviews:', err.message));
}
