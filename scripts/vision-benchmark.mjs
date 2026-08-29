#!/usr/bin/env node
/**
 * vision-benchmark.mjs
 *
 * Compare a candidate vision backend against the classifications already stored
 * in state/electrical-backfill.json, so "is the local model good enough?" gets a
 * number instead of a vibe.
 *
 * The stored labels came from GPT-4o. They are the baseline, not ground truth --
 * but agreement against them is exactly what matters when the question is
 * "can the local model replace the hosted one for this job?".
 *
 * Reports:
 *   - service_type agreement (the decision that picks which post a photo lands on)
 *   - approve/reject agreement (the decision that puts a photo on the page at all)
 *   - MISSED REJECTS: photos the baseline rejected but the candidate approved.
 *     This is the one that matters most -- the baseline rejects faces and PII, so
 *     a miss here means a customer's face could reach the business page.
 *   - parse failures (a "thinking" model that emits prose around its JSON)
 *   - mean seconds per photo, for planning a full library sweep
 *
 * USAGE
 *   node scripts/vision-benchmark.mjs --url http://192.168.1.240:8080/v1 \
 *        --model qwen3.8-27b --n 100
 *
 *   --no-think     send chat_template_kwargs {enable_thinking:false} (Qwen)
 *   --key <k>      bearer token, if the endpoint needs one
 *   --seed <n>     sample seed (default 42) so runs are comparable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let heicConvert = null;
try { heicConvert = (await import('heic-convert')).default; } catch { /* optional */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

function argValue(flag, dflt = null) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : dflt;
}
const URL_ = (argValue('--url') || 'http://192.168.1.240:8080/v1').replace(/\/$/, '');
const MODEL = argValue('--model') || 'qwen3.8-27b';
const N = parseInt(argValue('--n', '100'), 10);
const SEED = parseInt(argValue('--seed', '42'), 10);
const KEY = argValue('--key') || '';
const noThink = process.argv.includes('--no-think');

const MANIFEST = path.join(PROJECT_ROOT, 'state', 'electrical-backfill.json');
const MIN_SCORE = parseInt(process.env.ELECTRICAL_BACKFILL_MIN_SCORE || '40', 10);

// Byte-identical to classify-electrical.mjs's prompt. Kept in sync deliberately:
// benchmarking two backends against different prompts measures nothing.
const PROMPT = [
  'Score this photo 0-100 for use as a Google Business Profile post for an electrical contractor.',
  '',
  'High (70-100): professional electrical work — panels, wiring, conduit, EV chargers, fixtures, completed installs. Clean, well-lit, no faces.',
  'Medium (40-69): electrical work but partially obscured, cluttered, or poorly lit.',
  'Low (0-39): not electrical work, has faces/PII, screenshot, receipt, personal photo, unrelated.',
  '',
  'Set service_type to ONE of: panel, ev-charger, lighting, wiring, outlet, generator, other',
  '',
  'Tags — pick all that apply:',
  '  panel-upgrade, panel-replacement, main-panel, subpanel, breaker-box, breaker-replacement,',
  '  ev-charger, ev-charging-station, level-2-charger, ev-outlet,',
  '  lighting-fixture, recessed-lighting, outdoor-lighting, ceiling-fan, light-switch, dimmer,',
  '  wiring, wire-run, conduit, romex, junction-box,',
  '  outlet-installation, gfci-outlet, usb-outlet, dedicated-circuit,',
  '  generator, generator-installation, generator-inlet, transfer-switch, standby-generator,',
  '  electrical-safety, smoke-detector, whole-home, service-upgrade',
  '',
  'Reply ONLY with JSON: {"score":<0-100>,"service_type":"<type>","tags":["tag1"],"reject_reason":"<blank if score>=60>"}'
].join('\n');

function detectMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}
function isKnownRaster(buf) {
  return (buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x52 && buf[1] === 0x49);
}
function isHeicBuffer(buf) {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis|hevm|hevs)$/.test(buf.toString('ascii', 8, 12));
}

// Deterministic sample so two backends see the same photos.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function classify(imagePath) {
  let buf = fs.readFileSync(imagePath);
  let mime = detectMime(buf);
  if (isHeicBuffer(buf) || (/\.hei[cf]$/i.test(imagePath) && !isKnownRaster(buf))) {
    if (!heicConvert) throw new Error('heic-convert unavailable');
    buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
    mime = 'image/jpeg';
  }
  const body = {
    model: MODEL,
    max_tokens: 200,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ],
    }],
  };
  if (noThink) body.chat_template_kwargs = { enable_thinking: false };

  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers.Authorization = 'Bearer ' + KEY;

  const res = await fetch(URL_ + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const text = j.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in reply: ' + text.slice(0, 120).replace(/\n/g, ' '));
  return JSON.parse(m[0]);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const labelled = Object.entries(manifest)
  .filter(([p, e]) => e && e.status === 'done' && fs.existsSync(e.copiedTo && fs.existsSync(e.copiedTo) ? e.copiedTo : p))
  .map(([p, e]) => ({ file: e.copiedTo && fs.existsSync(e.copiedTo) ? e.copiedTo : p, base: e }));

const rand = mulberry32(SEED);
const sample = labelled
  .map((v) => ({ v, k: rand() }))
  .sort((a, b) => a.k - b.k)
  .slice(0, N)
  .map((x) => x.v);

console.log('=== Vision backend benchmark ===');
console.log(`Candidate:  ${MODEL} @ ${URL_}${noThink ? '  (thinking disabled)' : ''}`);
console.log(`Baseline:   stored labels in ${path.basename(MANIFEST)} (GPT-4o)`);
console.log(`Sample:     ${sample.length} of ${labelled.length} labelled photos (seed ${SEED})\n`);

let typeAgree = 0, decisionAgree = 0, parseFail = 0, errors = 0, scored = 0;
let totalMs = 0;
const missedRejects = [];
const typeConfusion = {};

for (const item of sample) {
  process.stdout.write('.');
  const t0 = Date.now();
  let r;
  try {
    r = await classify(item.file);
  } catch (e) {
    if (/no JSON in reply/.test(e.message)) parseFail++; else errors++;
    continue;
  }
  totalMs += Date.now() - t0;
  scored++;

  const baseType = item.base.service_type || 'other';
  const candType = r.service_type || 'other';
  if (baseType === candType) typeAgree++;
  else {
    const k = `${baseType} -> ${candType}`;
    typeConfusion[k] = (typeConfusion[k] || 0) + 1;
  }

  const baseApproved = !!item.base.approved;
  const candApproved = (Number(r.score) >= MIN_SCORE) && candType && candType !== 'other';
  if (baseApproved === candApproved) decisionAgree++;
  if (!baseApproved && candApproved) {
    missedRejects.push({
      file: path.basename(item.file),
      baseScore: item.base.score,
      baseReason: item.base.reject_reason || '',
      candScore: r.score,
      candType,
    });
  }
}

const pct = (n) => scored ? ((n / scored) * 100).toFixed(1) + '%' : 'n/a';
console.log('\n');
console.log(`Scored:              ${scored}`);
console.log(`Parse failures:      ${parseFail}${parseFail ? '   <-- model is wrapping prose around the JSON' : ''}`);
console.log(`Request errors:      ${errors}`);
console.log(`Mean per photo:      ${scored ? (totalMs / scored / 1000).toFixed(1) : '-'}s`);
console.log(`service_type agree:  ${typeAgree}  (${pct(typeAgree)})`);
console.log(`approve/reject agree:${decisionAgree}  (${pct(decisionAgree)})`);
console.log(`MISSED REJECTS:      ${missedRejects.length}   (baseline rejected, candidate approved)`);

if (missedRejects.length) {
  console.log('\nThese would have reached the page. Check them by eye — the baseline rejects faces/PII:');
  for (const m of missedRejects.slice(0, 15)) {
    console.log(`  ${m.file}  base ${m.baseScore} (${m.baseReason || 'rejected'})  ->  candidate ${m.candScore} [${m.candType}]`);
  }
}
if (Object.keys(typeConfusion).length) {
  console.log('\nService-type disagreements:');
  for (const [k, v] of Object.entries(typeConfusion).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${v.toString().padStart(3)}  ${k}`);
  }
}

const est = (n) => scored ? ((totalMs / scored) * n / 3600000).toFixed(1) : '?';
console.log(`\nAt this rate: 5,000 photos ~= ${est(5000)}h, 10,000 ~= ${est(10000)}h (serial).`);
