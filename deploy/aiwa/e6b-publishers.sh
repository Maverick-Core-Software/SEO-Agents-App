#!/usr/bin/env bash
# E6 part B: publisher-side dry run on seo-prod after the engine projected the week.
# Mirrors what gbp-worker / mav-bridge do at claim time (photo pick + workbook sync), then dry-runs
# the GBP API poster for the 7 GBP dates, the Facebook poster, the Day-1 slideshow render,
# reconcile --dry-run and the watchdog. Publishes NOTHING. Run as seo from /opt/seo.
set -u
cd /opt/seo || exit 2
export PATH=/usr/local/bin:/usr/bin:/bin
WEEK_OF="${1:-2026-10-19}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EV="/opt/seo/outputs/e2e-evidence/${STAMP}-publishers"
mkdir -p "$EV"
load_env() { node -e '
  const fs=require("fs");const s=fs.readFileSync("/opt/seo/.env","utf8");
  for (const l of s.split(/\r?\n/)) { const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) process.stdout.write(m[1]+"="+JSON.stringify(m[2])+"\n"); }'; }
eval "$(load_env | sed "s/^/export /")"
export SEO_AUTO_APPROVE=0 FB_BOOST_API=0 MAV_BRIDGE_GBP=off
echo "== pins: GBP_POSTER=$GBP_POSTER WEEK_OF=$WEEK_OF" | tee "$EV/00-pins.txt"

echo "== 1. GBP photo pick (gpt-4o scoring of candidates; copies winners, records sha256 in the manifest, syncs the workbook)"
timeout 1200 node scripts/gbp-photo-pick.mjs 2>&1 | tail -30 | tee "$EV/10-gbp-photo-pick.log"
echo "gbp-photo-pick exit=${PIPESTATUS[0]}" | tee -a "$EV/10-gbp-photo-pick.log"

echo "== 2. workbook sync (idempotent)"
node scripts/sync-gbp-schedule.mjs 2>&1 | tail -8 | tee "$EV/11-sync-gbp-schedule.log"
echo "sync exit=${PIPESTATUS[0]}" | tee -a "$EV/11-sync-gbp-schedule.log"

echo "== 3. GBP API poster --dry-run x7 (Day 1 = Friday = week_of - 3)"
for i in 0 1 2 3 4 5 6; do
  d=$(date -d "$WEEK_OF -3 day +$i day" +%F)
  node scripts/gbp-api-poster.mjs --date "$d" --dry-run 2>&1 | tee -a "$EV/20-gbp-dry-run.log"
  echo "gbp dry-run $d exit=${PIPESTATUS[0]}" | tee -a "$EV/20-gbp-dry-run.log"
done

echo "== 4. FB photo pick + Facebook poster --dry-run"
timeout 600 node scripts/fb-photo-pick.mjs 2>&1 | tail -15 | tee "$EV/30-fb-photo-pick.log"
echo "fb-photo-pick exit=${PIPESTATUS[0]}" | tee -a "$EV/30-fb-photo-pick.log"
timeout 1200 node scripts/facebook-poster.mjs --schedule-all --dry-run 2>&1 | tee "$EV/31-fb-dry-run.log"
echo "fb dry-run exit=${PIPESTATUS[0]}" | tee -a "$EV/31-fb-dry-run.log"

echo "== 5. slideshow render (first slideshow-type day in the FB schedule)"
DAY=$(grep -oE '"day": [0-9]+' "$EV/31-fb-dry-run.log" | head -1 | grep -oE '[0-9]+'); DAY="${DAY:-1}"
timeout 900 node scripts/slideshow-reel.mjs --day "$DAY" 2>&1 | tail -10 | tee "$EV/32-slideshow-build.log"
echo "slideshow day=$DAY exit=${PIPESTATUS[0]}" | tee -a "$EV/32-slideshow-build.log"
ls -la outputs/fb-videos 2>/dev/null | tail -4 | tee -a "$EV/32-slideshow-build.log"

echo "== 6. reconcile --dry-run, watchdog"
node scripts/weekly/reconcile.mjs --dry-run 2>&1 | tail -8 | tee "$EV/40-reconcile.log"
node scripts/seo-watchdog.mjs 2>&1 | tail -10 | tee "$EV/41-watchdog.log"
echo "watchdog exit=${PIPESTATUS[0]}" | tee -a "$EV/41-watchdog.log"
cp -f outputs/gbp_posting_schedule.md outputs/facebook_posting_schedule.md "$EV/" 2>/dev/null
echo "== evidence in $EV"; ls "$EV"
