// GBP post content-policy gate.
//
// Grounded in Google's published policies (fetched + reviewed 2026-08-01):
//   - Posts content policy (support.google.com/business/answer/7213077):
//     "We do not allow your post content to include a phone number." Links/CTAs
//     belong in the post's button, not the text.
//   - Prohibited & restricted content (support.google.com/business/answer/7400114):
//     offensive/sexual content, regulated goods (alcohol, tobacco, gambling,
//     weapons, pharma), personal info, off-topic, repetitive/duplicate content.
//   - Known auto-reject triggers observed in the field: phone numbers, URLs and
//     street addresses in post text; the word "sex" even in innocent contexts.
//
// Incident driving this module: 2026-07-31 — three scheduled posts carried
// "(469) 863-9804" in the caption; Google rejected all three within minutes and
// disabled posting profile-wide. This gate makes that class of failure
// impossible to ship again.
import fs from 'node:fs';
import path from 'node:path';

const CAPTION_MAX = 1500;
const IMAGE_MIN_BYTES = 10240;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

// Phone patterns: (469) 863-9804 / 469-863-9804 / 469.863.9804 / 4698639804 /
// +1 469 863 9804 / 863-9804 / vanity 555-555-TREE.
const PHONE_PATTERNS = [
    /(\+?1[\s.\-]?)?(\(\d{3}\)|\b\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}\b/,
    /\b\d{3}[\s.\-]\d{4}\b/,
    /\b\d{3}[\s.\-]\d{3}[\s.\-][A-Za-z]{4}\b/,
];

const URL_PATTERN = /(https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|co|us|biz|info|me|app|site|online)\b/i;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
// Street address or city/state+zip in text (addresses belong on the profile).
const ADDRESS_PATTERNS = [
    /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\s+){1,3}(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Pkwy|Parkway|Hwy|Highway)\.?\b/,
    /\b(Suite|Ste\.?|Unit|Apt\.?)\s*#?\s*\d+\b/i,
    /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/,
];

// "sex" is a documented auto-reject even in innocent phrases; the rest are
// plain profanity Google's filter treats as offensive content.
const BANNED_WORDS = /\b(sex\w*|fuck\w*|shit\w*|bitch\w*|damn(ed|it)?|porn\w*|nude|nudity)\b/i;

// Regulated goods/services (restricted content policy). An electrical
// contractor's posts should never mention these; any hit is a red flag.
const REGULATED = /\b(alcohol|beer|wine|liquor|vodka|whiskey|tobacco|cigarettes?|vapes?|vaping|cannabis|marijuana|cbd|kratom|guns?|firearms?|ammo|ammunition|casinos?|gambling|lottery|betting|pharmacy|pharmaceutical|prescription|opioids?)\b/i;

/**
 * Validate a post payload against Google's post content policy.
 * @param {{caption: string, imagePath?: string}} payload
 * @param {{otherCaptions?: string[]}} [opts] captions of OTHER rows, for duplicate detection
 * @returns {{rule: string, detail: string}[]} violations (empty = compliant)
 */
export function checkPostPolicy(payload, opts = {}) {
    const violations = [];
    const caption = String(payload.caption || '');

    if (!caption.trim()) {
        violations.push({ rule: 'empty-caption', detail: 'Caption is empty.' });
        return violations;
    }
    if (caption.length > CAPTION_MAX) {
        violations.push({ rule: 'caption-too-long', detail: `Caption is ${caption.length} chars (GBP limit ${CAPTION_MAX}).` });
    }

    for (const re of PHONE_PATTERNS) {
        const m = caption.match(re);
        if (m) {
            violations.push({ rule: 'phone-number', detail: `Phone number in post text ("${m[0].trim()}") — Google auto-rejects this. Use the CTA button; the profile's verified number powers "Call now".` });
            break;
        }
    }

    const url = caption.match(URL_PATTERN);
    if (url) {
        violations.push({ rule: 'url-in-text', detail: `URL/domain in post text ("${url[0].trim()}") — links belong in the CTA button, not the caption.` });
    }
    const email = caption.match(EMAIL_PATTERN);
    if (email) {
        violations.push({ rule: 'email-in-text', detail: `Email address in post text ("${email[0]}").` });
    }
    for (const re of ADDRESS_PATTERNS) {
        const m = caption.match(re);
        if (m) {
            violations.push({ rule: 'address-in-text', detail: `Street address/zip in post text ("${m[0].trim()}") — addresses belong on the profile, not in posts.` });
            break;
        }
    }

    const banned = caption.match(BANNED_WORDS);
    if (banned) {
        violations.push({ rule: 'banned-word', detail: `"${banned[0]}" triggers Google's offensive-content filter (even in innocent phrases).` });
    }
    const regulated = caption.match(REGULATED);
    if (regulated) {
        violations.push({ rule: 'regulated-content', detail: `"${regulated[0]}" falls under Google's restricted products/services policy.` });
    }

    const letters = caption.replace(/[^A-Za-z]/g, '');
    if (letters.length > 30) {
        const upper = caption.replace(/[^A-Z]/g, '').length;
        if (upper / letters.length > 0.6) {
            violations.push({ rule: 'all-caps', detail: 'Caption is mostly uppercase — reads as spam/shouting to the filter.' });
        }
    }

    if (Array.isArray(opts.otherCaptions)) {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const self = norm(caption);
        if (self && opts.otherCaptions.some((c) => norm(c) === self)) {
            violations.push({ rule: 'duplicate-caption', detail: 'Caption is identical to another post in the schedule — Google rejects repetitive content.' });
        }
    }

    if (payload.imagePath) {
        const ext = path.extname(payload.imagePath).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) {
            violations.push({ rule: 'image-format', detail: `Image extension "${ext}" — GBP reliably accepts only JPG/PNG.` });
        }
        if (fs.existsSync(payload.imagePath) && fs.statSync(payload.imagePath).size < IMAGE_MIN_BYTES) {
            violations.push({ rule: 'image-too-small', detail: `Image is under 10 KB — below Google's minimum for post photos.` });
        }
    }

    return violations;
}

export function formatViolations(violations) {
    return violations.map((v) => `  [${v.rule}] ${v.detail}`).join('\n');
}
