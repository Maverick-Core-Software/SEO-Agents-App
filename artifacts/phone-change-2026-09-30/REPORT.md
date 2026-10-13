# Grizzly Facebook cleanup and poster safeguards

September 30, 2026. Replace main 469-863-9804 with 469-716-9870;
preserve dedicated customer texting line 469-896-3862.

## Live Facebook changes

51 saved text updates: 13 post/reel captions through the owner UI, 37 existing
post messages through the Page API, and one uploaded-photo description through UI.
Only the retired phone was replaced; original prose, media and audience retained.
All 37 API writes have exact readback verification. UI saves were visibly confirmed.

- Feed inventory: 239 posts, complete pagination; 37 matches after the 13 UI edits.
- Uploaded-photo descriptions: 288, complete pagination; one additional match fixed.
- Video descriptions: 29, complete pagination; no matches.
- Comments: 74 inspected, 54 authored by the Page; no retired-number matches.
- Meta scheduled view: no scheduled posts. Drafts: no activity in displayed 90 days.
- Current local Facebook schedule, GBP schedule and action queue: no old-number matches.

Original text, post IDs and links are retained in facebook-ui-edits.json,
facebook-api-inventory.json and facebook-api-edits.jsonl. Separate inventories
record comments, photos and videos. The migration script defaults to read-only
and only updates existing owned post messages when explicitly run with --apply.

## Local poster changes

- scripts/facebook-poster.mjs: canonical new main default; stale environment override
  fallback; rejects assembled captions containing the retired main number.
- scripts/facebook-poster.selfcheck.mjs: focused checks for phone formats, permitted
  current numbers and rejection of stale queued captions.
- scripts/gbp-api-poster.mjs: applies existing GBP caption policy before approval/API
  posting. GBP captions remain phone-free and use profile calls to action. CLI entry
  guard resolves workspace junctions correctly.

Worker checks passed: facebook-poster.selfcheck.mjs, facebook-poster.test.mjs,
gbp-api-poster.mjs --selfcheck and gbp-poster/driver.selfcheck.mjs.
Independent review, syntax checks and targeted diff whitespace check passed.
No commits, pushes, service restarts or runtime deployment performed in this pass.

## Remaining limits

The inventories cover editable text, not numbers burned into images or video,
spoken in audio, expired stories, ad creatives or separately configured call buttons.
Other people's comments were not modified. Broader third-party directory and account
work remains recorded in Grizzly Launch/artifacts/phone-change-2026-09-30/STATUS.md.

Google's refreshed business result now displays (469) 716-9870; the website search
snippet still contains the old phone even though live website verification passed.
The dedicated Google Chat destination was submitted earlier; approval still unverified.
