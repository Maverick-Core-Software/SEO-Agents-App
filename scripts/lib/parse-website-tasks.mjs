/**
 * Parse website_tasks candidates from execution queue + final report Markdown.
 * Pure helpers — used by supabase-sync.mjs.
 */

export const OWNER_WAIT_STATUSES = new Set([
  'waiting_on_owner',
  'waiting_on_tool_access',
  'research_gap',
  'blocked',
  'blocked_by',
]);

/** True when a captured "title" is actually the TITLE:/EXCERPT:/TAGS: format line. */
export function isFormatInstructionTitle(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  // Captured value after mistaken TITLE: match, e.g. "/EXCERPT:/TAGS:` headers..."
  if (/^\/?EXCERPT\s*:/i.test(v)) return true;
  if (/^TAGS\s*:/i.test(v) && /header/i.test(v)) return true;
  if (/EXCERPT\s*:?\s*\/?\s*TAGS/i.test(v) && /static-site|publishing|HTML body/i.test(v)) return true;
  // Full instruction phrases
  if (/TITLE\s*:?\s*\/?\s*EXCERPT/i.test(v)) return true;
  if (/format the deliverable with/i.test(v) && /EXCERPT|TAGS/i.test(v)) return true;
  return false;
}

export function isOwnerWaitStatus(status) {
  // Strip markdown ticks/bold only — do NOT strip underscores (status ids use _).
  const s = String(status || '')
    .toLowerCase()
    .replace(/[`*]/g, '')
    .trim();
  if (!s) return false;
  if (OWNER_WAIT_STATUSES.has(s)) return true;
  // Status cells often look like: waiting_on_owner or `waiting_on_owner` (blocked until …)
  if (/waiting_on_owner|waiting_on_tool_access|research_gap/.test(s)) return true;
  if (/\bblocked\b/.test(s) && !/unblocked|not blocked/.test(s)) return true;
  return false;
}

function stripCodeFence(text) {
  return text.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function stripMd(str) {
  return (str || '').replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/**
 * Extract a labeled field without treating TITLE:/EXCERPT format instructions as Title.
 */
export function extractLabeledField(block, key) {
  const keyNorm = key.trim();
  // Table row: | **Task ID** | `T-…` |
  const tableRe = new RegExp(
    `\\|\\s*\\*{0,2}${escapeRegExp(keyNorm)}\\*{0,2}\\s*\\|\\s*([^|\\n]+)\\|`,
    'i',
  );
  const table = block.match(tableRe);
  if (table) {
    const val = stripMd(table[1]);
    if (keyNorm.toLowerCase() === 'title' || keyNorm.toLowerCase() === 'task title') {
      if (isFormatInstructionTitle(val)) return '';
    }
    return val;
  }

  // Line form: **Title:** value  /  **Task Title**: value
  // Negative lookahead blocks TITLE:/EXCERPT or TITLE: /EXCERPT
  const lineRe = new RegExp(
    `(?:^|\\n)\\s*(?:\\d+[\\.\\)]\\s*)?(?:-\\s*)?\\*{0,2}${escapeRegExp(keyNorm)}\\*{0,2}\\s*:\\s*(?!\\/?\\s*EXCERPT\\b)(?!\\s*TAGS\\b)(.+)`,
    'i',
  );
  const m = block.match(lineRe);
  if (!m) return '';
  let val = m[1].replace(/\*{0,2}\s*$/, '').trim();
  val = stripMd(val);
  if (keyNorm.toLowerCase() === 'title' || keyNorm.toLowerCase() === 'task title') {
    if (isFormatInstructionTitle(val)) return '';
    // Whole match was the format-instruction line (label itself was TITLE next to /EXCERPT)
    if (/TITLE\s*:?\s*\/?\s*EXCERPT/i.test(m[0])) return '';
  }
  return val;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefer real title fields; never return format-instruction garbage. */
export function extractTaskTitle(block, headerTitle = '') {
  const candidates = [
    extractLabeledField(block, 'Task Title'),
    extractLabeledField(block, 'TASK_TITLE'),
    extractLabeledField(block, 'Title'),
  ];
  for (const c of candidates) {
    if (c && !isFormatInstructionTitle(c)) return c;
  }
  const fromHeader = cleanHeaderTitle(headerTitle);
  if (fromHeader && !isFormatInstructionTitle(fromHeader)) return fromHeader;
  return '';
}

/** " [BLOG POST] Generator Interlock…" → clean title */
export function cleanHeaderTitle(headerTitle) {
  let t = String(headerTitle || '').trim();
  if (!t) return '';
  // Drop leading [BLOG POST] / tags
  t = t.replace(/^\[[^\]]+\]\s*/g, '').trim();
  t = stripMd(t);
  if (isFormatInstructionTitle(t)) return '';
  return t;
}

export function extractQueueStatus(block) {
  const raw =
    extractLabeledField(block, 'Status') ||
    extractLabeledField(block, 'Task Status') ||
    '';
  return raw.replace(/`/g, '').trim();
}

export function extractBlockedBy(block) {
  const deps = [];
  // **Dependencies:** bullets or "blocked until T-GES-…"
  const depSection = block.match(
    /\*{0,2}Dependencies\*{0,2}:?\s*\n([\s\S]*?)(?=\n\*{0,2}[A-Z][a-zA-Z ]+\*{0,2}:|\n###|\n##|$)/i,
  );
  const text = depSection ? depSection[1] : block;
  for (const m of text.matchAll(/\b(T-GES-[A-Z0-9-]+|\bT[A-Z0-9-]*\d+)\b/gi)) {
    deps.push(m[1]);
  }
  if (/blocked\s+until/i.test(block) || /BLOCKED until/i.test(block)) {
    // keep deps from that sentence
  }
  return [...new Set(deps)];
}

export function extractDescription(block, status) {
  const explicit =
    extractLabeledField(block, 'Description') ||
    extractLabeledField(block, 'DESCRIPTION') ||
    '';
  if (explicit && !isFormatInstructionTitle(explicit)) {
    return explicit;
  }
  const steps =
    block.match(
      /\*{0,2}Exact Action Steps:?\*{0,2}:?\s*\n([\s\S]*?)(?=\n\*{0,2}Acceptance Criteria|\n\*{0,2}Verification|\n\*{0,2}Rollback|\n###|\n##|$)/i,
    )?.[1]?.trim() || '';
  const parts = [];
  if (status) parts.push(`Status: ${status}`);
  if (steps) parts.push(steps);
  // First non-table paragraph after header fields as fallback
  if (!steps) {
    const prose = block
      .split(/\n\n+/)
      .map((p) => p.trim())
      .find(
        (p) =>
          p &&
          !p.startsWith('|') &&
          !p.startsWith('#') &&
          !/^\*{0,2}(Task ID|Run ID|Status|Priority)/i.test(p) &&
          !isFormatInstructionTitle(p),
      );
    if (prose) parts.push(prose.slice(0, 800));
  }
  return parts.filter(Boolean).join('\n\n');
}

export function mapTaskType(raw) {
  const r = String(raw || '').toLowerCase();
  if (r.includes('blog')) return 'blog_post';
  if (r.includes('service')) return 'service_update';
  if (r.includes('promo')) return 'promotion';
  if (r.includes('alert') || r.includes('broken') || r.includes('fix')) return 'alert';
  return 'seo_fix';
}

export function mapPriority(raw) {
  const r = String(raw || '').toLowerCase();
  if (r.includes('critical') || /\bp0\b/.test(r)) return 'critical';
  if (r.includes('high') || /\bp1\b/.test(r)) return 'high';
  if (r.includes('low') || /\bp[34]\b/.test(r)) return 'low';
  return 'medium';
}

export function classifyTask(title, description) {
  const text = `${title} ${description}`.toLowerCase();

  let platform = 'other';
  if (/google|business profile|gbp|google my business/.test(text)) platform = 'gbp';
  else if (/facebook|instagram|post to|social media|tiktok|linkedin/.test(text)) platform = 'social';
  else if (/citation|directory|yelp|bbb|angies|yellow pages|listings?/.test(text)) platform = 'directory';
  else if (
    /page|blog|meta|title tag|schema|sitemap|robots|homepage|faq|content|home page|index\.|edit|update|service|website|static-site|\/blog\//.test(
      text,
    )
  ) {
    platform = 'website';
  }

  let website_action_type = null;
  if (platform === 'website') {
    if (/blog/.test(text)) website_action_type = 'website_blog_post';
    else if (/service/.test(text)) website_action_type = 'website_service_page_update';
    else if (/faq/.test(text)) website_action_type = 'website_faq_update';
    else if (/hour/.test(text)) website_action_type = 'website_hours_update';
    else if (/contact.?form|phone|email/.test(text)) website_action_type = 'website_contact_form_update';
    else if (/gallery/.test(text)) website_action_type = 'website_gallery_update';
    else if (/nav|layout|header|footer|sitemap|robots/.test(text)) website_action_type = 'website_layout_update';
    else website_action_type = 'website_copy_update';
  }

  return { platform, website_action_type };
}

export function mergeClassification(details, task) {
  const classified = classifyTask(task.title, task.description || '');
  const merged = { ...details };
  merged.platform = classified.platform;
  if (classified.website_action_type) merged.website_action_type = classified.website_action_type;
  return merged;
}

function pushTask(tasks, seenTitles, task) {
  const title = (task.title || '').trim();
  if (!title || isFormatInstructionTitle(title)) return;
  if (seenTitles.has(title)) return;
  seenTitles.add(title);
  tasks.push(task);
}

/**
 * Build website_tasks rows from report Markdown.
 * Owner-wait / blocked queue statuses are preserved as non-executable rows
 * (status waiting_on_owner), never pending_approval.
 */
export function parseWebsiteTasks(executionQueueText, finalReportText) {
  const tasks = [];
  const seenTitles = new Set();

  if (finalReportText) {
    const clean = stripCodeFence(finalReportText);

    const incompleteSection =
      clean.match(/##\s+Incomplete[^#]*([\s\S]*?)(?=\n##|$)/i)?.[1] || '';
    const tableRows = [
      ...incompleteSection.matchAll(/\|\s*(T\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g),
    ];
    for (const [, id, title, missing, next] of tableRows) {
      const t = title.trim();
      if (!t || isFormatInstructionTitle(t)) continue;
      pushTask(tasks, seenTitles, {
        type: 'seo_fix',
        priority: 'high',
        title: t,
        description: `Missing: ${missing.trim()}\nNext step: ${next.trim()}`,
        details: mergeClassification(
          { task_id: id.trim(), source: 'final_report' },
          { title: t, description: `Missing: ${missing.trim()}\nNext step: ${next.trim()}` },
        ),
        status: 'pending_approval',
      });
    }

    const headerBlocks = [
      ...clean.matchAll(/###\s+Task\s+\d+[:\s]+([^\n]+)([\s\S]*?)(?=\n###|\n##|$)/gi),
    ];
    for (const [, headerTitle, body] of headerBlocks) {
      const title = extractTaskTitle(body, headerTitle);
      if (!title) continue;
      const missing =
        extractLabeledField(body, 'What was missing') ||
        extractLabeledField(body, 'Missing') ||
        '';
      const next =
        extractLabeledField(body, 'Recommended Next Step') ||
        extractLabeledField(body, 'Next Step') ||
        '';
      const taskId =
        extractLabeledField(body, 'Task ID') || extractLabeledField(body, 'Task Id') || '';
      const description = [missing && `Missing: ${missing}`, next && `Next step: ${next}`]
        .filter(Boolean)
        .join('\n');
      pushTask(tasks, seenTitles, {
        type: 'seo_fix',
        priority: 'high',
        title,
        description,
        details: mergeClassification(
          { task_id: taskId, source: 'final_report' },
          { title, description },
        ),
        status: 'pending_approval',
      });
    }

    const statusBlocks = [
      ...clean.matchAll(
        /###[^\n]*?\b(T[A-Z0-9-]*\d)\b[^\n]*?[—–-]\s*(PARTIAL|INCOMPLETE|BLOCKED|NOT[ _]?DONE|FAILED)[^\n]*\n([\s\S]*?)(?=\n###|\n##(?!#)|$)/gi,
      ),
    ];
    for (const [, taskId, , body] of statusBlocks) {
      const title = extractTaskTitle(body);
      if (!title) continue;
      const blocker = extractLabeledField(body, 'Blocker');
      const next =
        extractLabeledField(body, 'Recommended Next Step') ||
        extractLabeledField(body, 'Next Step');
      const description = [blocker && `Blocker: ${blocker}`, next && `Next step: ${next}`]
        .filter(Boolean)
        .join('\n');
      pushTask(tasks, seenTitles, {
        type: mapTaskType(title),
        priority: 'high',
        title,
        description,
        details: mergeClassification(
          { task_id: taskId, source: 'final_report' },
          { title, description },
        ),
        status: 'pending_approval',
      });
    }
  }

  if (executionQueueText) {
    const clean = stripCodeFence(executionQueueText);

    // Format A/B legacy blocks
    const hrBlocks = clean.split(/\n\s*---\s*\n/).filter((b) => /Task\s+(ID|Title)/i.test(b));
    const headerMatches = [
      ...clean.matchAll(/##\s+Task\s+\d+[:\s]+[^\n]+([\s\S]*?)(?=\n##|\n#|$)/gi),
    ];
    const headerBlocks = headerMatches.map((m) => m[0]);
    const allBlocks = hrBlocks.length ? hrBlocks : headerBlocks;

    for (const block of allBlocks) {
      const title = extractTaskTitle(block);
      if (!title) continue;
      const status = extractQueueStatus(block);
      const rawPriority =
        extractLabeledField(block, 'Priority') || extractLabeledField(block, 'PRIORITY') || '';
      const type =
        extractLabeledField(block, 'Action Type') ||
        extractLabeledField(block, 'Task Type') ||
        extractLabeledField(block, 'Type') ||
        extractLabeledField(block, 'TYPE') ||
        '';
      const taskId =
        extractLabeledField(block, 'Task ID') || extractLabeledField(block, 'Task Id') || '';
      const description = extractDescription(block, status);
      const blockedBy = extractBlockedBy(block);
      const ownerWait =
        isOwnerWaitStatus(status) ||
        (blockedBy.length > 0 && /blocked until|waiting_on_owner/i.test(block));
      const rowStatus = ownerWait ? 'waiting_on_owner' : 'pending_approval';
      // completed/done still skip
      if (/^(complete|done|verified|shipped)\b/i.test(status)) continue;

      pushTask(tasks, seenTitles, {
        type: mapTaskType(type || title),
        priority: mapPriority(rawPriority),
        title,
        description,
        details: mergeClassification(
          {
            task_id: taskId,
            source: 'execution_queue',
            queue_status: status || null,
            blocked_by: blockedBy,
          },
          { title, description },
        ),
        status: rowStatus,
      });
    }

    // Format C: ### T-GES-… — optional header title
    // Allow title on the same line after em-dash (current research queue format).
    const idBlocks = [
      ...clean.matchAll(
        /###\s+(T[A-Z0-9-]*\d)(?:\s*[—–-]\s*([^\n]+))?\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/g,
      ),
    ];
    for (const [, taskId, headerTitle, body] of idBlocks) {
      const title = extractTaskTitle(body, headerTitle);
      if (!title) continue;
      const status = extractQueueStatus(body);
      if (/^(complete|done|verified|shipped)\b/i.test(status)) continue;

      const type =
        extractLabeledField(body, 'Action Type') ||
        extractLabeledField(body, 'Task Type') ||
        extractLabeledField(body, 'Type') ||
        '';
      // Header tags like [BLOG POST] count as blog
      const typeHint = /\[?\s*BLOG\s*POST\s*\]?/i.test(headerTitle || '') ? 'blog' : type;
      const description = extractDescription(body, status);
      const blockedBy = extractBlockedBy(body);
      const ownerWait =
        isOwnerWaitStatus(status) ||
        (blockedBy.length > 0 && /blocked until|waiting_on_owner/i.test(body));
      const rowStatus = ownerWait ? 'waiting_on_owner' : 'pending_approval';

      pushTask(tasks, seenTitles, {
        type: mapTaskType(typeHint || title),
        priority: mapPriority(extractLabeledField(body, 'Priority')),
        title,
        description,
        details: mergeClassification(
          {
            task_id: taskId,
            source: 'execution_queue',
            queue_status: status || null,
            blocked_by: blockedBy,
          },
          { title, description },
        ),
        status: rowStatus,
      });
    }
  }

  return tasks;
}

/**
 * Runner-side gate: only approved (or mid-flight executing), non-owner-wait,
 * non-garbage-title tasks may run live website edits.
 */
export function isWebsiteTaskExecutable(task) {
  if (!task) return false;
  const status = String(task.status || '').toLowerCase();
  // Only approved tasks start; 'executing' is mid-flight after CAS claim.
  if (status !== 'approved' && status !== 'executing') return false;
  if (isFormatInstructionTitle(task.title || '')) return false;
  if (isOwnerWaitStatus(status)) return false;
  const qs = task.details?.queue_status || task.details?.status_from_queue || '';
  if (isOwnerWaitStatus(qs)) return false;
  if (/blocked until|waiting_on_owner/i.test(String(task.description || ''))) return false;
  return true;
}
