// scripts/lib/gbp-listing.mjs
// Pure helpers + Playwright listing checks for GBP All-posts modal.
// Shared by gbp-poster/driver.mjs (pre-submit duplicate guard + verifyPosted)
// and verify-gbp-posts.mjs (scrolled listing confirm). No browser launch here.

export function captionSnippet(caption) {
  if (!caption) return '';
  const line = String(caption).split(/\n/).find((l) => l.trim().length > 10)
    || String(caption).split(/\n/).map((l) => l.trim()).find(Boolean)
    || String(caption);
  return line.trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function isGbpSessionExpiredText(text) {
  return /session expired|sign in|signed out|logged out|accounts\.google\.com|marketing page|Stand out on Google|free Business Profile|Get your free Business Profile/i
    .test(String(text || ''));
}

export function gbpListingUnverifiedMessage(parsed = {}) {
  const snapshot = parsed.verificationSnapshot?.textFile || parsed.verificationSnapshot?.screenshot || '';
  const suffix = snapshot ? ` Snapshot: ${snapshot}` : '';
  return `GBP post not found on listing. Check listing, do not re-post.${suffix}`;
}

// Card text from the All-posts modal. Scheduled rows are queued, not live.
export function classifyPostCardText(cardText, snippet) {
  const hay = String(cardText || '').replace(/\s+/g, ' ').trim();
  const needle = String(snippet || '').replace(/\s+/g, ' ').trim();
  if (!hay || !needle) return null;
  if (!hay.toLowerCase().includes(needle.toLowerCase())) return null;
  if (/\bScheduled\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i.test(hay)) {
    return 'scheduled';
  }
  if (/\bScheduled\s+\d{1,2}\b/i.test(hay)) return 'scheduled';
  if (/\bPublished\b/i.test(hay)) return 'live';
  if (/\b\d+\s+(minute|hour|day|week)s?\s+ago\b/i.test(hay)) return 'live';
  return 'live';
}

export function listingMatchFromCards(cards, snippet) {
  let scheduled = null;
  for (const text of cards || []) {
    const match = classifyPostCardText(text, snippet);
    if (match === 'live') return 'live';
    if (match === 'scheduled') scheduled = 'scheduled';
  }
  return scheduled;
}

// Pre-submit duplicate guard. Workbook Posted is the hard lock. A listing hit
// (live or Google-queued for today) must not compose a second post.
export function gbpShouldSubmitLivePost({ workbookPosted, listingMatch } = {}) {
  if (workbookPosted) return { submit: false, reason: 'workbook_posted' };
  if (listingMatch === 'live') return { submit: false, reason: 'already_live' };
  if (listingMatch === 'scheduled') return { submit: false, reason: 'already_queued' };
  return { submit: true, reason: 'missing' };
}

function shouldStopScrolling({ found, scrollTop, lastScrollTop, stuck }) {
  if (found) return true;
  if (scrollTop === lastScrollTop && stuck >= 2) return true;
  return false;
}

export function gbpListingScrollDecision(state = {}) {
  return shouldStopScrolling(state);
}

// --- Playwright (page is injected; never launch Chromium here) ---

export async function assertGbpLoggedIn(page) {
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error('GBP session expired (redirected to Google sign-in). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
  const signIn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")').first();
  if (await signIn.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP session expired (Sign in button visible). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
  const marketing = page.getByText(/Stand out on Google|free Business Profile|Get your free Business Profile/i).first();
  if (await marketing.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
}

async function allPostsAlreadyOpen(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: /All posts|Your posts/i }).first();
  if (await dialog.isVisible({ timeout: 800 }).catch(() => false)) return true;
  for (const frame of page.frames()) {
    const visible = await frame.getByText(/^All posts$/i).first().isVisible({ timeout: 400 }).catch(() => false);
    if (visible) return true;
  }
  return false;
}

export async function openAllPostsModal(page) {
  if (await allPostsAlreadyOpen(page)) return true;

  const postsBtn = page.locator('button:has-text("Posts"), a:has-text("Posts")').first();
  if (await postsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    // GBP overlays an iframe on the Posts control; a normal click times out on intercept.
    await postsBtn.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  if (await allPostsAlreadyOpen(page)) return true;

  const seeAll = page.locator(
    'button:has-text("See all"), a:has-text("See all"), button:has-text("All posts"), [aria-label*="All posts" i]',
  ).first();
  if (await seeAll.isVisible({ timeout: 2000 }).catch(() => false)) {
    await seeAll.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  return allPostsAlreadyOpen(page);
}

const COLLECT_CARDS_JS = (snip) => {
  const dialog = document.querySelector('[role="dialog"]');
  const root = dialog || document.body;
  const nodes = [...root.querySelectorAll('div,li,article')];
  const hits = [];
  const needle = String(snip || '').toLowerCase();
  for (const n of nodes) {
    const t = (n.innerText || '').trim();
    if (t.length < 8 || t.length > 900) continue;
    if (!t.toLowerCase().includes(needle)) continue;
    hits.push(t);
  }
  hits.sort((a, b) => a.length - b.length);
  const uniq = [];
  for (const t of hits) {
    if (!uniq.some((u) => u === t)) uniq.push(t);
  }
  return uniq.slice(0, 8);
};

const SCROLL_MODAL_JS = () => {
  const dialog = document.querySelector('[role="dialog"]');
  const root = dialog || document.body;
  const candidates = [root, ...root.querySelectorAll('*')].filter((el) => {
    try {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      return el.scrollHeight > el.clientHeight + 24 && (oy === 'auto' || oy === 'scroll' || oy === 'overlay');
    } catch {
      return false;
    }
  });
  const scroller = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (!scroller) {
    window.scrollBy(0, 400);
    return window.scrollY;
  }
  scroller.scrollTop += Math.max(Math.floor(scroller.clientHeight * 0.85), 180);
  return scroller.scrollTop;
};

async function collectMatchingCardTexts(page, snippet) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    const hits = await frame.evaluate(COLLECT_CARDS_JS, snippet).catch(() => []);
    if (hits?.length) return hits;
  }
  return [];
}

async function scrollAllPostsModal(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  let last = -1;
  for (const frame of frames) {
    const top = await frame.evaluate(SCROLL_MODAL_JS).catch(() => -1);
    if (typeof top === 'number' && top > last) last = top;
  }
  return last;
}

export async function findSnippetInAllPosts(page, snippet) {
  const needle = captionSnippet(snippet) || String(snippet || '').trim();
  if (!needle) return { match: null, postUrl: null, cardText: null };

  await openAllPostsModal(page);

  let lastScrollTop = -1;
  let stuck = 0;
  for (let i = 0; i < 16; i++) {
    const cards = await collectMatchingCardTexts(page, needle);
    const match = listingMatchFromCards(cards, needle);
    if (match) {
      const cardText = cards.find((t) => classifyPostCardText(t, needle) === match) || cards[0] || null;
      const postUrl = match === 'live' ? await extractListingPostUrl(page, needle) : null;
      return { match, postUrl, cardText };
    }
    const more = page.getByRole('button', { name: /More posts/i }).first();
    if (await more.isVisible({ timeout: 250 }).catch(() => false)) {
      await more.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const scrollTop = await scrollAllPostsModal(page);
    if (scrollTop === lastScrollTop) {
      stuck += 1;
      if (gbpListingScrollDecision({ found: false, scrollTop, lastScrollTop, stuck })) break;
    } else {
      stuck = 0;
      lastScrollTop = scrollTop;
    }
    await page.waitForTimeout(350);
  }

  const cards = await collectMatchingCardTexts(page, needle);
  const match = listingMatchFromCards(cards, needle);
  if (!match) return { match: null, postUrl: null, cardText: null };
  const cardText = cards.find((t) => classifyPostCardText(t, needle) === match) || cards[0] || null;
  const postUrl = match === 'live' ? await extractListingPostUrl(page, needle) : null;
  return { match, postUrl, cardText };
}

export async function extractListingPostUrl(page, snippet) {
  const extractJs = (text) => {
    const allAnchors = [...document.querySelectorAll('a[href*="localPost"], a[href*="/posts/"]')];
    if (allAnchors.length) return allAnchors[0].href;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && text && node.textContent.includes(text)) {
        const link = node.closest?.('a[href]') || node.parentElement?.closest?.('a[href]');
        if (link) return link.href;
      }
    }
    return null;
  };
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const href = await frame.evaluate(extractJs, snippet).catch(() => null);
    if (href) return href;
  }
  return null;
}
