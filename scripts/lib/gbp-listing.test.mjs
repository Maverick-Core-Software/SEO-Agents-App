import assert from 'node:assert/strict';
import {
  captionSnippet,
  isGbpSessionExpiredText,
  gbpListingUnverifiedMessage,
  classifyPostCardText,
  listingMatchFromCards,
  gbpShouldSubmitLivePost,
  gbpListingScrollDecision,
} from './gbp-listing.mjs';

assert.equal(
  captionSnippet('Before You Buy an EV Charger, Check Your Panel\nMore body'),
  'Before You Buy an EV Charger, Check Your Panel',
);
assert.equal(captionSnippet(''), '');

assert.equal(isGbpSessionExpiredText('GBP session expired (redirected to Google sign-in)'), true);
assert.equal(isGbpSessionExpiredText('logged-out Business Profile marketing page shown'), true);
assert.equal(isGbpSessionExpiredText('Stand out on Google with a free Business Profile'), true);
assert.equal(isGbpSessionExpiredText('verification failed after 4 attempts'), false);

assert.ok(gbpListingUnverifiedMessage().includes('do not re-post'));
assert.ok(gbpListingUnverifiedMessage({ verificationSnapshot: { textFile: 'C:/x.json' } }).includes('C:/x.json'));

const scheduledCard = 'Before You Buy an EV Charger, Check Your Panel\nScheduled Aug 30';
const publishedCard = 'Before You Buy an EV Charger, Check Your Panel\nPublished 10 minutes ago';
const recessed = 'Recessed lighting that looks clean and fits the room';

assert.equal(classifyPostCardText(scheduledCard, 'Before You Buy an EV Charger, Check Your Panel'), 'scheduled');
assert.equal(classifyPostCardText(publishedCard, 'Before You Buy an EV Charger, Check Your Panel'), 'live');
assert.equal(classifyPostCardText(scheduledCard, recessed), null);

assert.equal(
  listingMatchFromCards([
    '5 Questions to Ask Before Hiring an Electrician\nScheduled Sep 4',
    scheduledCard,
  ], 'Before You Buy an EV Charger, Check Your Panel'),
  'scheduled',
);
assert.equal(
  listingMatchFromCards([
    '5 Questions to Ask Before Hiring an Electrician\nScheduled Sep 4',
    publishedCard,
  ], 'Before You Buy an EV Charger, Check Your Panel'),
  'live',
);
assert.equal(
  listingMatchFromCards([
    '5 Questions to Ask Before Hiring an Electrician\nScheduled Sep 4',
    scheduledCard,
  ], recessed),
  null,
);
// Live wins if both a scheduled leftover and a published card match.
assert.equal(
  listingMatchFromCards([scheduledCard, publishedCard], 'Before You Buy an EV Charger, Check Your Panel'),
  'live',
);

assert.deepEqual(gbpShouldSubmitLivePost({ workbookPosted: true, listingMatch: null }), { submit: false, reason: 'workbook_posted' });
assert.deepEqual(gbpShouldSubmitLivePost({ listingMatch: 'live' }), { submit: false, reason: 'already_live' });
assert.deepEqual(gbpShouldSubmitLivePost({ listingMatch: 'scheduled' }), { submit: false, reason: 'already_queued' });
assert.deepEqual(gbpShouldSubmitLivePost({ listingMatch: null }), { submit: true, reason: 'missing' });

assert.equal(gbpListingScrollDecision({ found: true, scrollTop: 0, lastScrollTop: 0, stuck: 0 }), true);
assert.equal(gbpListingScrollDecision({ found: false, scrollTop: 400, lastScrollTop: 200, stuck: 0 }), false);
assert.equal(gbpListingScrollDecision({ found: false, scrollTop: 800, lastScrollTop: 800, stuck: 2 }), true);
assert.equal(gbpListingScrollDecision({ found: false, scrollTop: 800, lastScrollTop: 800, stuck: 1 }), false);

console.log('ok gbp-listing helpers');
