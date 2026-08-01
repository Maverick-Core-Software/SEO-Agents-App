// Lint every non-Posted row of the GBP schedule workbook against Google's post
// content policy — run this after the crew writes a new week, BEFORE any driver
// run. Exit 0 = all clean, exit 5 = violations found (matches the driver's
// policy_violation exit code).
//
//   node scripts/gbp-poster/lint-workbook.mjs [--config path] [--all]
//
// --all includes Posted rows too (audit mode; they're already live so violations
// there are informational only and do not affect the exit code).
import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { checkPostPolicy, formatViolations } from './policy-check.mjs';

const DEFAULT_CONFIG = 'C:\\Workspace\\Active\\SEO-Agents-App\\config\\gbp-poster.config.json';

const argv = process.argv.slice(2);
const configPath = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : DEFAULT_CONFIG;
const includePosted = argv.includes('--all');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const workbookPath = path.join(config.config_dir, config.workbook_path);
if (!fs.existsSync(workbookPath)) {
    console.error(`Workbook not found: ${workbookPath}`);
    process.exit(1);
}

function excelDateToIso(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'number') {
        const parsed = xlsx.SSF.parse_date_code(value);
        if (parsed) {
            return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
        }
    }
    return String(value || '').slice(0, 10);
}

const workbook = xlsx.readFile(workbookPath);
const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

const posts = rows.map((row) => ({
    date: excelDateToIso(row.Date || row.date),
    status: String(row.Status || '').trim(),
    posted: Boolean(row.Posted),
    caption: String(row.CaptionDraft || row.Body || row.Caption || '').trim(),
    imagePath: String(row.AssetIdOrDescription || row['Related Picture'] || '').trim(),
}));

let checked = 0;
let dirtyPending = 0;
let dirtyPosted = 0;
for (const post of posts) {
    if (post.posted && !includePosted) continue;
    checked++;
    const otherCaptions = posts.filter((p) => p !== post).map((p) => p.caption).filter(Boolean);
    const violations = checkPostPolicy(post, { otherCaptions });
    if (violations.length > 0) {
        const tag = post.posted ? 'POSTED (informational)' : (post.status || '(no status)');
        console.log(`\n${post.date} [${tag}]`);
        console.log(formatViolations(violations));
        if (post.posted) dirtyPosted++; else dirtyPending++;
    }
}

console.log(`\nChecked ${checked} row(s): ${dirtyPending} pending with violations${includePosted ? `, ${dirtyPosted} already-posted with violations` : ''}.`);
process.exit(dirtyPending > 0 ? 5 : 0);
