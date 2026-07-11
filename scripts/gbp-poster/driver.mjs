import { chromium } from 'playwright';
import xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);

const DEFAULT_CONFIG = 'C:\\Workspace\\Active\\SEO-Agents-App\\config\\gbp-poster.config.json';
const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'gbp-session');
const VIEWPORT = { width: 1365, height: 900 };
const DEBUG_DIR = 'C:\\Workspace\\Active\\SEO-Agents-App\\outputs\\gbp-debug';
const VERIFY_DELAY_MS = 60_000;
const VERIFY_ATTEMPTS = 5;
// Pre-submit compose steps may be retried (nothing has been posted yet). Once the
// Post button is clicked we NEVER retry — a re-send would create a duplicate post.
const POST_ATTEMPTS = 2;

// ponytail: schedule time is fixed at 9:00 AM business-local; make it a config
// field if a second time is ever needed.
const SCHEDULE_TIME_LABEL = /^9:00[\s\u202F]*AM$/;

// Map an error message to a coarse, actionable failure reason so logs/results say
// *why* a run failed without a human reading a stack trace. Order matters: the
// human-blocking cases (session/captcha) are checked before generic timeouts.
function classifyFailure(message) {
    const m = String(message || '').toLowerCase();
    if (/sign in|signed out|logged out|session expired|accounts\.google\.com/.test(m)) return 'session_expired';
    if (/captcha|unusual traffic|not a robot|verify it'?s you|\/sorry\//.test(m)) return 'captcha';
    if (/image not found|no post found|no caption|workbook not found|not approved/.test(m)) return 'data';
    if (/could not find|waiting for|timeout|timed out|exceeded|did not register/.test(m)) return 'ui_changed_or_timeout';
    return 'unknown';
}

// Only transient/UI failures are worth retrying. session_expired needs re-auth and
// captcha needs a human — retrying those just wastes a browser launch.
const RETRYABLE = new Set(['ui_changed_or_timeout']);

// Step-level progress to stderr (stdout is reserved for the JSON result the caller parses).
function logStep(step, extra) {
    const stamp = new Date().toISOString();
    console.error(`[gbp-driver ${stamp}] ${step}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// Detect Google anti-bot interstitials early and fail with a clear, categorizable
// message instead of letting a downstream "could not find <button>" timeout hide it.
async function detectBlockingInterstitial(page) {
    if (/\/sorry\/|recaptcha/i.test(page.url())) {
        throw new Error(`CAPTCHA / unusual-traffic interstitial from Google (url: ${page.url()}). A human must solve it, then re-run.`);
    }
    const captchaFrame = page.locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]').first();
    if (await captchaFrame.isVisible({ timeout: 500 }).catch(() => false)) {
        throw new Error('CAPTCHA challenge detected on the page. A human must solve it, then re-run.');
    }
    const challenge = page.getByText(/unusual traffic|verify it'?s you|confirm you'?re not a robot|i'?m not a robot/i).first();
    if (await challenge.isVisible({ timeout: 500 }).catch(() => false)) {
        throw new Error('Google anti-bot challenge detected ("unusual traffic" / "verify it\'s you"). A human must complete it, then re-run.');
    }
}

function parseArgs(argv) {
    const args = { dryRun: false, auth: false, headless: false, date: null, schedule: false, config: DEFAULT_CONFIG };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--auth') args.auth = true;
        else if (arg === '--headless') args.headless = true;
        else if (arg === '--date') args.date = argv[++i];
        else if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
        else if (arg === '--config') args.config = argv[++i];
        else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length);
        else if (arg === '--schedule') args.schedule = true;
    }
    args.date ||= new Date().toISOString().slice(0, 10);
    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function parseSchedule(filePath, targetDate) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });
    const post = data.find((row) => excelDateToIso(row.Date || row.date) === targetDate);
    if (!post) throw new Error(`No post found for date: ${targetDate}`);
    return post;
}

function buildPayload(post) {
    const caption = String(post.CaptionDraft || post.Body || post.Caption || '').trim();
    const imagePath = String(post.AssetIdOrDescription || post['Related Picture'] || '').trim();
    return {
        date: excelDateToIso(post.Date || post.date),
        status: String(post.Status || '').trim(),
        topic: String(post.Topic || post.Title || '').trim(),
        caption,
        imagePath,
        posted: Boolean(post.Posted),
    };
}

async function clickFirst(page, selectors, label) {
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count()) {
            await locator.click({ timeout: 10000 });
            return selector;
        }
    }
    throw new Error(`Could not find ${label}. Tried: ${selectors.join(', ')}`);
}

async function assertLoggedIn(page) {
    if (/accounts\.google\.com/.test(page.url())) {
        throw new Error('GBP session expired (redirected to Google sign-in). Re-authenticate with: node driver.mjs --auth');
    }
    const signIn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")').first();
    if (await signIn.isVisible({ timeout: 1000 }).catch(() => false)) {
        throw new Error('GBP session is logged out (Sign in button visible). Re-authenticate with: node driver.mjs --auth');
    }
    // Expired sessions sometimes land on the public GBP marketing page instead of
    // redirecting to accounts.google.com. Catch it explicitly so it's reported as
    // session_expired (→ needs --auth) rather than a downstream ui_changed timeout.
    const loggedOutMarketing = page.getByText(
        /Stand out on Google|free Business Profile|Get your free Business Profile/i,
    ).first();
    if (await loggedOutMarketing.isVisible({ timeout: 1000 }).catch(() => false)) {
        throw new Error('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node driver.mjs --auth');
    }
}

async function openUpdateComposer(page) {
    await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await detectBlockingInterstitial(page);
    await assertLoggedIn(page);

    const directAddUpdate = page.locator('button:has-text("Add update")').first();
    const postsButton = page.locator('button:has-text("Posts")').first();
    await directAddUpdate.or(postsButton).first().waitFor({ timeout: 20000 });

    if (await directAddUpdate.count()) {
        await directAddUpdate.scrollIntoViewIfNeeded({ timeout: 10000 });
        await directAddUpdate.click({ timeout: 10000 });
    } else {
        await clickFirst(page, ['button:has-text("Posts")'], 'posts button');
        const addPost = page.locator(
            'button:has-text("Add post"), div[role="button"]:has-text("Add a post"), button:has-text("Add update")'
        ).first();
        await addPost.waitFor({ timeout: 15000 });
        await addPost.click({ timeout: 10000 });
    }

    // Composer may open as a dialog on the Search results page (current flow),
    // inside an iframe (older Knowledge Panel flow), or directly. Wait for the
    // actual composer to render — NOT just any contenteditable, since Google's
    // search box is also contenteditable and would resolve instantly.
    await Promise.race([
        page.locator('div[role="dialog"]')
            .filter({ has: page.getByText(/Add post|Schedule this post|Description/i) })
            .first().waitFor({ timeout: 20000 }),
        page.frameLocator('iframe[src*="promote/updates/add"]')
            .locator('[contenteditable="true"], textarea').first()
            .waitFor({ timeout: 20000 }),
    ]).catch(() => {});
}

// Returns the composer context. Google now renders the GBP "Add post" composer
// as a modal dialog on the Google Search results page (the merged "Your business
// on Google" experience), but older accounts may still open it inside an iframe.
// Scoping to the dialog/iframe is critical: otherwise locators like
// [contenteditable="true"] match Google's own search box on the page.
async function getComposerCtx(page) {
    // 1. New merged Search UI: composer is a dialog containing "Add post".
    const dialog = page.locator('div[role="dialog"]')
        .filter({ has: page.getByText(/Add post|Schedule this post|Description/i) })
        .first();
    try {
        await dialog.waitFor({ timeout: 4000 });
        if (await dialog.count()) return dialog;
    } catch {}

    // 2. Legacy iframe flow.
    const ifl = page.frameLocator('iframe[src*="promote/updates/add"]');
    try {
        await ifl.locator('[contenteditable="true"], textarea').first().waitFor({ timeout: 2000 });
        return ifl;
    } catch {}

    // 3. Fallback: the page itself (legacy business.google.com native composer).
    return page;
}

function composerInput(ctx) {
    // Prefer the explicitly-labelled Description field; fall back to the first
    // editable element within the (already dialog-scoped) composer context.
    return ctx.locator(
        'textarea[aria-label="Description" i], [contenteditable="true"][aria-label="Description" i], ' +
        'textarea[placeholder="Description" i], [placeholder="Description" i], ' +
        'textarea:not([name="q"]):not([aria-label*="Search" i]), ' +
        '[contenteditable="true"]:not([aria-label*="Search" i])'
    ).first();
}

async function attachImage(ctx, imagePath, page) {
    const existingInput = ctx.locator('input[type="file"]').first();
    if (await existingInput.count()) {
        await existingInput.setInputFiles(imagePath, { timeout: 15000 });
    } else {
        const selectText = ctx.getByText('Select images and videos', { exact: true }).first();
        await selectText.waitFor({ timeout: 15000 });
        // file chooser event must be watched on the main page
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
        await selectText.click({ timeout: 10000 });
        const chooser = await chooserPromise;
        await chooser.setFiles(imagePath);
    }
    // Wait for upload thumbnail
    await ctx.locator('img[src^="blob:"], img[src^="data:"]').first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
    await page.waitForTimeout(1500);
}

async function fillComposerDescription(ctx, value, page) {
    const input = composerInput(ctx);
    await input.waitFor({ timeout: 15000 });
    await input.click({ timeout: 10000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(value);
    const typed = (await input.innerText().catch(() => '')) || (await input.inputValue().catch(() => ''));
    if (!typed || !typed.includes(value.slice(0, 30))) {
        throw new Error('Caption text did not register in the composer description field.');
    }
}

async function setComposerSchedule(ctx, page, isoDate) {
    // Convert yyyy-mm-dd → MM/DD/YYYY
    const parts = isoDate.split('-');
    const formatted = `${parts[1]}/${parts[2]}/${parts[0]}`;

    logStep('engaging schedule toggle');
    const toggle = ctx.getByRole('switch', { name: 'Schedule post' });
    await toggle.click({ timeout: 10000 });
    const isChecked = await toggle.getAttribute('aria-checked');
    assert.equal(isChecked, 'true', 'Schedule toggle did not engage — it will classify as ui_changed_or_timeout');

    logStep('typing schedule date');
    const dateCombobox = ctx.getByRole('combobox', { name: /Date/i }).first();
    await dateCombobox.click({ timeout: 10000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(formatted);
    await page.keyboard.press('Tab');
    const readback = (await dateCombobox.inputValue().catch(() => '')) || '';
    assert.equal(readback, formatted, `Date read-back mismatch: expected ${formatted}, got ${readback}`);

    logStep('selecting 9:00 AM schedule time');
    const timeCombobox = ctx.getByRole('combobox', { name: 'Time' }).first();
    await timeCombobox.click({ timeout: 10000 });
    await ctx.getByRole('option', { name: SCHEDULE_TIME_LABEL }).first().click({ timeout: 10000 });
    const timeReadback = (await timeCombobox.inputValue().catch(() => '')) || '';
    assert.ok(SCHEDULE_TIME_LABEL.test(timeReadback), `Time read-back mismatch: expected 9:00 AM (tolerant), got '${timeReadback}'`);
}

async function setComposerCta(ctx, page, url) {
    logStep('revealing CTA link fields');
    const addLinkBtn = ctx.locator('button[aria-label="Add link fields"]').first();
    await addLinkBtn.click({ timeout: 10000 });

    logStep('opening button type menu');
    const typeBtn = ctx.getByRole('button', { name: 'None' }).first();
    await typeBtn.click({ timeout: 10000 });

    logStep('picking Learn more');
    await ctx.getByRole('menuitem', { name: 'Learn more' }).first().click({ timeout: 10000 });

    logStep('typing CTA URL');
    const urlInput = ctx.getByRole('textbox', { name: /Link for your button/ }).first();
    await urlInput.click({ timeout: 10000 });
    await page.keyboard.insertText(url);
    const readback = await urlInput.inputValue().catch(() => '');
    assert.equal(readback, url, `CTA URL read-back mismatch: expected ${url}, got ${readback}`);
}

async function clickComposerPost(ctx, page) {
    const postButton = ctx.getByRole('button', { name: 'Post', exact: true }).last();
    if (!(await postButton.count())) {
        throw new Error('Could not find the Post submit button in the composer.');
    }
    await postButton.click({ timeout: 10000 });

    // Composer closing = GBP accepted submission
    await composerInput(ctx).waitFor({ state: 'hidden', timeout: 30000 });

    const errorBanner = ctx.locator('text=/something went wrong|couldn\'t be posted|could not be posted|try again/i').first();
    if (await errorBanner.isVisible({ timeout: 1000 }).catch(() => false)) {
        throw new Error(`GBP showed an error after submitting: ${(await errorBanner.innerText().catch(() => '')).trim()}`);
    }
}

function resolveCtaUrl(payload, config) {
    const map = config?.cta_url_map || {};
    // Topic is exhausted before caption: captions often mention other services in
    // passing (e.g. an EV-charger post discussing panel capacity).
    for (const hay of [payload.topic, payload.caption]) {
        const lower = String(hay || '').toLowerCase();
        for (const [key, url] of Object.entries(map)) {
            if (lower.includes(key)) return url;
        }
    }
    return config?.default_cta_url || null;
}

function captionSnippet(caption) {
    const firstLine = caption.split('\n').map((line) => line.trim()).find(Boolean) || caption;
    return firstLine.replace(/\s+/g, ' ').slice(0, 60).trim();
}

async function saveVerificationSnapshot(page, caption, visible, attempt) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshot = path.join(DEBUG_DIR, `verify-attempt-${attempt}-${stamp}.png`);
    const textFile = path.join(DEBUG_DIR, `verify-attempt-${attempt}-${stamp}.json`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    const texts = await page.locator('a,button,div[role="button"],span,h1,h2,h3,textarea,[contenteditable="true"],input')
        .evaluateAll(nodes => [...new Set(nodes.map(n => (
            n.innerText || n.textContent || n.getAttribute('aria-label') || n.getAttribute('placeholder') || ''
        ).trim()).filter(Boolean).slice(0, 300))])
        .catch(() => []);
    fs.writeFileSync(textFile, JSON.stringify({
        url: page.url(),
        caption_snippet: captionSnippet(caption),
        verified_visible: visible,
        verification_attempt: attempt,
        verification_attempts: VERIFY_ATTEMPTS,
        texts,
    }, null, 2));
    return { screenshot, textFile };
}

async function checkPostVisible(page, snippet) {
    await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Posts section may be inside an iframe on the profile page
    const postsIframe = page.frameLocator('iframe[src*="contribute"], iframe[src*="posts"], iframe[src*="local/business"]').first();

    // Check main page text first (some GBP layouts show posts inline)
    let visible = await page.getByText(snippet, { exact: false }).first()
        .isVisible({ timeout: 5000 }).catch(() => false);

    // Fall back: check inside the posts iframe
    if (!visible) {
        visible = await postsIframe.getByText(snippet, { exact: false }).first()
            .isVisible({ timeout: 8000 }).catch(() => false);
    }

    // Fall back: try clicking Posts button and re-check
    if (!visible) {
        const postsButton = page.locator('button:has-text("Posts")').first();
        if (await postsButton.count()) {
            await postsButton.click({ timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
            visible = await page.getByText(snippet, { exact: false }).first()
                .isVisible({ timeout: 8000 }).catch(() => false);
        }
    }

    return visible;
}

async function verifyPosted(page, caption) {
    const snippet = captionSnippet(caption);
    let verificationSnapshot = null;

    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
        // Give GBP another minute to index/moderate the submitted post before reloading.
        await page.waitForTimeout(VERIFY_DELAY_MS);
        const visible = await checkPostVisible(page, snippet);
        verificationSnapshot = await saveVerificationSnapshot(page, caption, visible, attempt);

        if (visible) {
            const postUrl = await page.evaluate(() => {
                const anchor = [...document.querySelectorAll('a[href*="localPost"], a[href*="/posts/"]')][0];
                return anchor ? anchor.href : null;
            }).catch(() => null);
            return { verified: true, postUrl, verificationSnapshot, verificationAttempts: attempt };
        }
    }

    return { verified: false, postUrl: null, verificationSnapshot, verificationAttempts: VERIFY_ATTEMPTS };
}

async function saveFailureArtifacts(page) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshot = path.join(DEBUG_DIR, `failure-${stamp}.png`);
    const textFile = path.join(DEBUG_DIR, `failure-${stamp}.json`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    const texts = await page.locator('a,button,div[role="button"],span,h1,h2,h3,textarea,[contenteditable="true"],input')
        .evaluateAll(nodes => [...new Set(nodes.map(n => (
            n.innerText || n.textContent || n.getAttribute('aria-label') || n.getAttribute('placeholder') || ''
        ).trim()).filter(Boolean).slice(0, 300))])
        .catch(() => []);
    fs.writeFileSync(textFile, JSON.stringify({ url: page.url(), texts }, null, 2));
    return { screenshot, textFile };
}

function emitResult(result) {
    console.log(JSON.stringify(result));
}

// Open the composer, fill it, attach the image, and submit. The PRE-submit work is
// retried on transient/UI failures; once `submitted` flips true we rethrow without
// retrying so a half-accepted post is never re-sent (duplicate guard).
async function composeAndSubmit(page, payload, schedule = false) {
    let lastErr;
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        let submitted = false;
        try {
            logStep(`compose attempt ${attempt}/${POST_ATTEMPTS}`, { date: payload.date });
            await openUpdateComposer(page);
            const ctx = await getComposerCtx(page);
            await fillComposerDescription(ctx, payload.caption, page);
            if (payload.imagePath) {
                await attachImage(ctx, payload.imagePath, page);
            }
            if (payload.ctaUrl) {
                try {
                    await setComposerCta(ctx, page, payload.ctaUrl);
                } catch (err) {
                    // ponytail: CTA is nice-to-have — never let it block the post.
                    logStep(`CTA failed (${err.message}) — posting without button`);
                }
            }
            if (schedule) {
                await setComposerSchedule(ctx, page, payload.date);
            }
            logStep('submitting post');
            submitted = true; // past here a failure must NOT trigger a re-submit
            await clickComposerPost(ctx, page);
            logStep('post submitted, composer closed');
            return;
        } catch (e) {
            lastErr = e;
            const reason = classifyFailure(e.message);
            logStep('compose failed', { attempt, reason, submitted, message: String(e.message || e) });
            if (submitted || !RETRYABLE.has(reason) || attempt >= POST_ATTEMPTS) {
                if (submitted) e.submitted = true;
                throw e;
            }
            logStep('retrying after reload (nothing was submitted)');
            await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForTimeout(2000);
        }
    }
    throw lastErr;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const config = readJson(args.config);

    if (args.auth) {
        const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: false,
            viewport: VIEWPORT,
        });
        const page = await context.newPage();
        console.log('AUTH MODE: Log into Google Business Profile, then close this browser window.');
        await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
        await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
        await context.close();
        return;
    }

    const workbookPath = path.join(config.config_dir, config.workbook_path);
    if (!workbookPath || !fs.existsSync(workbookPath)) {
    // Fallback to default config if workbook_path is not set
    if (!config.workbook_path) {
        console.warn('Workbook path not set in config, using default: C:\\Workspace\\Active\\SEO-Agents-App\\outputs\\gbp_posting_schedule.xlsx');
        workbookPath = 'C:\\Workspace\\Active\\SEO-Agents-App\\outputs\\gbp_posting_schedule.xlsx';
    }
        throw new Error(`Workbook not found: ${workbookPath || '(missing workbook_path)'}`);
    }

    const postData = parseSchedule(workbookPath, args.date);
    const payload = buildPayload(postData);
    payload.ctaUrl = resolveCtaUrl(payload, config);
    if (!payload.caption) throw new Error(`Post ${args.date} has no caption/body text.`);

    // If workbook image path is missing/stale, fall back to the curated folder by date prefix.
    // gbp-photo-pick.mjs renames photos as {date}-{service}.{ext} but only updates the markdown
    // schedule — not the Excel workbook — so workbook paths can lag behind curation.
    if (payload.imagePath && !fs.existsSync(payload.imagePath)) {
        const curatedDir = config.curated_photo_folder || '';
        if (curatedDir && fs.existsSync(curatedDir)) {
            const prefix = `${payload.date}-`;
            const candidates = fs.readdirSync(curatedDir)
                .filter(f => f.toLowerCase().startsWith(prefix.toLowerCase()))
                .sort();
            if (candidates.length > 0) {
                const fallback = path.join(curatedDir, candidates[0]);
                console.warn(`[driver] Workbook image not found (${payload.imagePath}) → curated fallback: ${fallback}`);
                payload.imagePath = fallback;
            }
        }
    }

    if (payload.imagePath && !fs.existsSync(payload.imagePath)) {
        throw new Error(`Post image not found: ${payload.imagePath}`);
    }
    if (!args.dryRun && payload.status !== 'Approved') {
        // Approval gate, not a failure: the post is awaiting human approval in the
        // workbook. Exit 4 (distinct from 1=failed / 3=unverified) so the caller can
        // classify this as needs-approval instead of recording a hard posting error.
        const message = `Post ${args.date} is not Approved. Current status: ${payload.status || '(blank)'}`;
        emitResult({ result: 'needs_approval', date: payload.date, verified: false, postUrl: null, error: message });
        console.error(message);
        process.exit(4);
    }
    if (!args.dryRun && payload.posted) {
        throw new Error(`Post ${args.date} is already marked Posted in the workbook.`);
    }

    const preview = {
        date: payload.date,
        status: payload.status,
        topic: payload.topic,
        caption_chars: payload.caption.length,
        image_path: payload.imagePath,
        image_exists: payload.imagePath ? fs.existsSync(payload.imagePath) : false,
        workbook_path: workbookPath,
        schedule: args.schedule,
        cta: payload.ctaUrl || null,
    };
    console.log(JSON.stringify({ mode: args.dryRun ? 'dry-run' : 'live', payload: preview }, null, 2));

    if (args.dryRun) {
        if (args.schedule) {
            emitResult({ result: 'schedule_dry_run', date: payload.date, scheduledTime: '9:00 AM', verified: false, postUrl: null, cta: payload.ctaUrl });
        } else {
            emitResult({ result: 'dry_run', date: payload.date, verified: false, postUrl: null });
        }
        return;
    }

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: args.headless,
        viewport: VIEWPORT,
    });
    const page = await context.newPage();

    try {
        await composeAndSubmit(page, payload, args.schedule);
        if (args.schedule) {
            // A scheduled post is not live yet — the Posts-list check would always
            // fail. The composer closing without error IS the confirmation.
            emitResult({ result: 'scheduled_native', date: payload.date, scheduledTime: '9:00 AM', verified: false, postUrl: null });
            console.log('Post scheduled natively on GBP.');
            return;
        }
        // composeAndSubmit returning means the post WAS submitted (the composer
        // closed, which GBP treats as acceptance). A verification failure here
        // must NOT be reported as 'failed' (exit 1) — that masks the successful
        // submission and causes a later re-run to double-post, because the caller
        // sees a hard error and retries a post that is already live. Wrap
        // verification so any throw becomes a 'posted + unverified' (exit 3),
        // which the caller treats as "check manually, do not auto-retry".
        let verified = false, postUrl = null, verificationSnapshot = null, verificationAttempts = 0;
        try {
            ({ verified, postUrl, verificationSnapshot, verificationAttempts } = await verifyPosted(page, payload.caption));
        } catch (verifyErr) {
            console.error(`Post was submitted but verification crashed (${verifyErr.message}). Treat as posted-but-unverified — do NOT retry without checking GBP first.`);
            verificationSnapshot = await saveFailureArtifacts(page).catch(() => null);
        }
        emitResult({ result: 'posted', date: payload.date, verified, postUrl, verificationSnapshot, verificationAttempts });
        if (verified) {
            console.log('Post submitted and verified on GBP.');
        } else {
            console.error(`Post was submitted (composer closed cleanly) but could not be verified in the Posts list after ${VERIFY_ATTEMPTS} checks. Check GBP manually before retrying — retrying may create a duplicate.`);
            process.exitCode = 3;
        }
    } catch (e) {
        if (args.schedule && e.submitted) {
            // Duplicate guard: the Post click already happened, so this must never
            // fall back to a live re-post. Exit 3 → runner marks scheduled_native
            // with an error note; daily verification confirms or alerts.
            emitResult({ result: 'schedule_unconfirmed', date: payload.date, scheduledTime: '9:00 AM', verified: false, postUrl: null, error: String(e.message || e) });
            console.error(`Schedule submit clicked but composer errored (${e.message || e}). Do NOT retry — daily verification will confirm or alert.`);
            process.exitCode = 3;
        } else {
            const reason = classifyFailure(e.message);
            const artifacts = await saveFailureArtifacts(page);
            emitResult({ result: 'failed', date: payload.date, verified: false, postUrl: null, failure_reason: reason, error: String(e.message || e) });
            console.error(`Error during GBP posting [${reason}]:`, e.message || e);
            console.error(`Debug artifacts: ${JSON.stringify(artifacts)}`);
            process.exitCode = 1;
        }
    } finally {
        await context.close();
    }
}

// Run only when executed directly so a self-check (or other caller) can import
// classifyFailure without launching a browser.
const invokedDirectly = process.argv[1]
    && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(__filename)).href;

if (invokedDirectly) {
    main().catch((error) => {
        console.error(error.message || error);
        process.exit(1);
    });
}

export { classifyFailure };
