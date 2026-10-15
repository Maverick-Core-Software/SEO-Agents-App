#!/usr/bin/env bash
# E6: the full dry run on seo-prod (CT 107). Run as user seo from /opt/seo. Nothing publishes:
#   - weekly pipeline --mode new for the coming week (SEO_AUTO_APPROVE=0 -> rows land pending_approval)
#   - GBP API poster --dry-run for the 7 dates (no create; prints image/hash/manifest checks)
#   - Facebook poster --dry-run (schedule-all, builds media incl. one slideshow; no publish)
#   - reconcile --dry-run, watchdog once
# Evidence goes to /opt/seo/outputs/e2e-evidence/<stamp>/ and is pulled to docs/cutover/evidence on the PC.
set -u
cd /opt/seo || exit 2
export PATH=/usr/local/bin:/usr/bin:/bin
WEEK_OF="${1:-2026-10-19}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EV="/opt/seo/outputs/e2e-evidence/$STAMP"
mkdir -p "$EV"
# Load .env the way the services do (hand-rolled parser; never `source` it).
load_env() { node -e '
  const fs=require("fs");const s=fs.readFileSync("/opt/seo/.env","utf8");
  for (const l of s.split(/\r?\n/)) { const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) process.stdout.write(m[1]+"="+JSON.stringify(m[2])+"\n"); }'; }
eval "$(load_env | sed "s/^/export /")"
export SEO_PIPELINE=new SEO_AUTO_APPROVE=0 FB_BOOST_API=0 MAV_BRIDGE_GBP=off
echo "== env pins: SEO_PIPELINE=$SEO_PIPELINE SEO_AUTO_APPROVE=$SEO_AUTO_APPROVE GBP_POSTER=$GBP_POSTER TZ=$TZ WEEK_OF=$WEEK_OF" | tee "$EV/00-pins.txt"
node -e 'console.log("TZ probe:", new Date().toString())' | tee -a "$EV/00-pins.txt"

echo "== 1a. wrapper rehearsal (offline fixtures, isolated dir, no network, no alerts)"
timeout 900 .venv/bin/python scripts/run-weekly-seo.py --rehearsal 2>&1 | tail -15 | tee "$EV/10-wrapper-rehearsal.log"
echo "rehearsal exit=${PIPESTATUS[0]}" | tee -a "$EV/10-wrapper-rehearsal.log"

echo "== 1b. weekly engine, new mode, week_of $WEEK_OF (Supabase store; rows land pending_approval; --notify exercises the Slack hop)"
# The wrapper has no --week-of: it would take the copied outputs/week_spec.json (week of 10-12, already
# posted) and the V4 rerun guard would refuse. Friday's real run goes through the wrapper.
timeout 1800 node scripts/weekly/run.mjs --mode new --week-of "$WEEK_OF" --notify 2>&1 | tee "$EV/11-weekly-new.log"
echo "weekly-new exit=${PIPESTATUS[0]}" | tee -a "$EV/11-weekly-new.log"
cp -f outputs/attempt.json outputs/projection.json outputs/summary.md outputs/*_posting_schedule.md "$EV/" 2>/dev/null

echo "== 2. GBP API poster --dry-run x7 (GBP Day 1 is the run Friday = week_of - 3 days)"
for i in 0 1 2 3 4 5 6; do
  d=$(date -d "$WEEK_OF -3 day +$i day" +%F)
  node scripts/gbp-api-poster.mjs --date "$d" --dry-run 2>&1 | tee -a "$EV/20-gbp-dry-run.log"
  echo "gbp dry-run $d exit=${PIPESTATUS[0]}" | tee -a "$EV/20-gbp-dry-run.log"
done

echo "== 3. Facebook poster --dry-run (schedule-all)"
timeout 1200 node scripts/facebook-poster.mjs --schedule-all --dry-run 2>&1 | tee "$EV/30-fb-dry-run.log"
echo "fb dry-run exit=${PIPESTATUS[0]}" | tee -a "$EV/30-fb-dry-run.log"
ls -la outputs/fb-videos 2>/dev/null | tail -5 | tee -a "$EV/30-fb-dry-run.log"

echo "== 3b. slideshow render check (ffmpeg on Linux; builds the Day-1 reel into outputs/fb-videos, publishes nothing)"
timeout 900 node scripts/slideshow-reel.mjs --day 1 2>&1 | tail -15 | tee "$EV/31-slideshow-build.log"
echo "slideshow exit=${PIPESTATUS[0]}" | tee -a "$EV/31-slideshow-build.log"
ls -la outputs/fb-videos 2>/dev/null | tail -3 | tee -a "$EV/31-slideshow-build.log"

echo "== 4. reconcile --dry-run, watchdog"
node scripts/weekly/reconcile.mjs --dry-run 2>&1 | tail -20 | tee "$EV/40-reconcile.log"
node scripts/seo-watchdog.mjs 2>&1 | tail -20 | tee "$EV/41-watchdog.log"
echo "watchdog exit=${PIPESTATUS[0]}" | tee -a "$EV/41-watchdog.log"
cp -f outputs/reconcile-health.json "$EV/" 2>/dev/null

echo "== evidence in $EV"
ls -la "$EV"
