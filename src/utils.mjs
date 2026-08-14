// Utility functions — zero deps

/**
 * Simple glob matching (supports * and **)
 */
export function minimatch(filepath, pattern) {
  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regex}$`).test(filepath);
}

/**
 * Count lines in a diff
 */
export function countDiffLines(diff) {
  return diff.split('\n').length;
}

/**
 * Truncate text to max length with indicator
 */
export function truncate(text, maxLen = 60000) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n... (truncated, diff too large)';
}

/**
 * Get action input with fallback
 */
export function getInput(name, defaultValue = '') {
  const envKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] || defaultValue;
}

/**
 * Parse owner/repo from GITHUB_REPOSITORY
 */
export function parseRepo() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

/**
 * Read GitHub event payload
 */
export async function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH not set');
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(path, 'utf8');
  return JSON.parse(data);
}

/**
 * Sanitize text to prevent prompt injection.
 */
export function sanitize(text) {
  if (!text) return '';
  return text
    // Strip HTML comments (prompt injection vector)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip invisible Unicode: zero-width chars, bidi overrides, BOM, line/paragraph separators
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u2069\uFEFF\u00AD]/g, '')
    // Strip javascript: URLs in markdown links
    .replace(/\[([^\]]*)\]\((?:javascript|data|vbscript):(?:[^)(]*|\([^)]*\))*\)/gi, '$1')
    // Strip hidden CSS display:none elements
    .replace(/<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]*>/gi, '')
    // Strip markdown image alt text (injection vector) — preserve image link
    .replace(/!\[([^\]]+)\]\(/g, '![](')
    // Strip markdown link title attributes
    .replace(/(\[[^\]]*\]\([^\s)]+)\s+["'][^"']*["']\)/g, '$1)')
    // Redact GitHub tokens
    .replace(/\b(ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/g, '[REDACTED]');
}

/**
 * Parse unified diff to extract valid (file, line) pairs for inline comments.
 * Returns Map<filepath, Set<lineNumber>> for lines visible in the diff (RIGHT side).
 */
export function parseDiffMap(diffText) {
  const map = new Map();
  let currentFile = null;
  let newLine = 0;

  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!map.has(currentFile)) map.set(currentFile, new Set());
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1]);
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      map.get(currentFile).add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deleted line — don't increment new line counter
    } else if (!line.startsWith('\\')) {
      // context line — valid for inline comments
      map.get(currentFile).add(newLine);
      newLine++;
    }
  }

  return map;
}

/**
 * Extract and strip the pr-metadata JSON block from review content.
 * Returns { title, description, cleanContent } where title/description are null if no change needed.
 */
export function extractPRMetadata(reviewContent) {
  const match = reviewContent.match(/```pr-metadata\n([\s\S]*?)\n```/);
  if (!match) return { title: null, description: null, cleanContent: reviewContent };

  const cleanContent = reviewContent.replace(/\n*```pr-metadata\n[\s\S]*?\n```\n*/g, '').trim();

  try {
    const { title, description } = JSON.parse(match[1]);
    return { title: title || null, description: description || null, cleanContent };
  } catch {
    console.error('Failed to parse pr-metadata JSON block');
    return { title: null, description: null, cleanContent };
  }
}

/**
 * Heuristic: is this push effectively just a merge from the base branch?
 * A commit with 2+ parents and a "Merge ..." message is almost always a
 * merge-from-main and not new logic worth reviewing.
 */
export function isMergeCommitPush(commit) {
  if (!commit) return false;
  if (!commit.parents || commit.parents.length < 2) return false;
  const firstLine = (commit.message || '').split('\n')[0];
  return /^Merge\b/i.test(firstLine);
}

const GENERIC_FINDING_PATTERNS = [
  /missing\s+(file\s+)?newline|trailing\s+newline|no\s+newline\s+at\s+end\s+of\s+file/i,
  /no\s+test\s+coverage|thiếu\s+(unit\s+)?test|missing\s+unit\s+test|consider\s+adding\s+tests/i,
  /generic\s+security\s+(hardening|advice)|consider\s+adding\s+logging/i,
];

/**
 * Drop or demote findings that match patterns a linter/formatter or
 * boilerplate-advice filter would already catch. The system prompt already
 * asks the model to avoid these, but it doesn't always listen.
 *
 * Only drops when the finding has no specific file:line anchor — generic
 * advice without a target. When includeNitpicks is true, demotes the
 * severity to 🔵/Nitpick instead of dropping.
 */
export function filterGenericFindings(findings, { includeNitpicks = false } = {}) {
  const out = [];
  for (const finding of findings) {
    const haystack = `${finding.title || ''}\n${finding.body || ''}`;
    const matches = GENERIC_FINDING_PATTERNS.some(p => p.test(haystack));
    if (!matches) {
      out.push(finding);
      continue;
    }
    // Has a real file:line anchor — keep, the prose may still be useful.
    if (finding.file && finding.line) {
      out.push(finding);
      continue;
    }
    if (includeNitpicks) {
      const demoted = { ...finding, severity: '🔵', severityLabel: 'Nitpick' };
      demoted.raw = finding.raw
        .replace(/^🔴|^🟠|^🟡/, '🔵')
        .replace(/\*\*(Critical|Major|Minor)\s*—/, '**Nitpick —');
      out.push(demoted);
    }
    // otherwise drop entirely
  }
  return out;
}

/**
 * Reconcile a finding's file path against the set of files actually in the
 * current diff. Returns `{ file, raw }` with potentially updated values.
 *
 * - If `finding.file` is in `diffFiles`, no change.
 * - If a file with the same basename exists in `diffFiles`, swap the path
 *   (covers renames between reviews, e.g. MinioRepositoryImpl → FCIStorageImpl).
 * - Otherwise, drop the trailing `path:line` reference from `raw` so the
 *   rendered comment doesn't point at a path that no longer exists.
 */
export function reconcilePath(finding, diffFiles) {
  if (!finding.file) return { file: finding.file, raw: finding.raw, dropped: false };
  if (diffFiles.has(finding.file)) {
    return { file: finding.file, raw: finding.raw, dropped: false };
  }
  const basename = finding.file.split('/').pop();
  for (const candidate of diffFiles) {
    if (candidate.split('/').pop() === basename) {
      const rewritten = finding.raw.replaceAll(finding.file, candidate);
      return { file: candidate, raw: rewritten, dropped: false };
    }
  }
  // No match — strip the `path:line` reference from raw so we don't render a
  // dead path. Keep severity/title prose intact.
  const lineRef = '`' + finding.file + ':' + finding.line + '`';
  const stripped = finding.raw
    .replaceAll(' — ' + lineRef, '')
    .replaceAll(lineRef, '');
  return { file: null, raw: stripped, dropped: true };
}

/**
 * Heuristic: did the LLM actually produce a meaningful review?
 * Returns false for:
 *  - near-empty / metadata-only output
 *  - free-form narration that skipped the prescribed `### Tóm tắt / ### Findings
 *    / ### ✅ Điểm tốt` skeleton (e.g. `## Analysis` followed by per-file `### 1. file`)
 *  - mid-stream cutoffs that produced no actual findings
 *
 * Accept only when the text contains at least one of:
 *  - a prescribed section heading
 *  - a finding line that starts with a severity emoji
 */
export function hasMeaningfulContent(text) {
  if (!text) return false;
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (stripped.length < 80) return false;
  const hasPrescribedSection = /^###\s*(?:Tóm tắt|Findings|Cần verify|✅\s*Điểm tốt|PR Metadata)\b/m.test(stripped);
  const hasSeverityFinding = /^(?:🔴|🟠|🟡|🔵)\s/m.test(stripped);
  return hasPrescribedSection || hasSeverityFinding;
}

// Batched reviews repeat boilerplate ("Không có vấn đề nghiêm trọng") across
// sections — keep each distinct line once, in order.
function dedupeLines(sections) {
  const seen = new Set();
  const kept = [];
  for (const line of sections.join('\n').split('\n')) {
    const key = line.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  return kept;
}

/**
 * Parse review markdown into structured findings for inline comments.
 * Returns { summary, findings: [{ severity, severityLabel, title, file, line, body, raw }], positives }
 */
export function parseFindings(reviewContent) {
  const result = { summary: '', findings: [], positives: '' };

  // A large PR is reviewed in batches whose responses are concatenated, so every
  // section can appear more than once. Matching only the first one dropped every
  // finding after the first batch.
  const sections = (pattern) =>
    [...reviewContent.matchAll(pattern)].map(m => m[1].trim()).filter(Boolean);

  result.summary = dedupeLines(sections(/###\s*Tóm tắt\n([\s\S]*?)(?=^###\s|$)/gm)).join('\n');
  result.positives = dedupeLines(sections(/###\s*✅\s*Điểm tốt\n([\s\S]*?)(?=^###\s|$)/gm)).join('\n');

  // Stop at the next `###` header of any kind, not just `### ✅`. `### Cần verify`
  // sits between Findings and Điểm tốt, and anchoring only on ✅ would append that
  // whole section to the body of the last finding — and post it as an inline comment.
  const findingsSections = sections(/###\s*Findings\n([\s\S]*?)(?=^###\s|$)/gm);
  if (findingsSections.length === 0) return result;

  const findingBlocks = findingsSections.flatMap(s => s.split(/(?=^(?:🔴|🟠|🟡|🔵))/m));

  for (const block of findingBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Parse: 🟠 **Major — Missing null check** — `src/order/service.ts:42`
    const headerMatch = trimmed.match(
      /^(🔴|🟠|🟡|🔵)\s+\*\*(\w+)\s*—\s*(.+?)\*\*\s*—?\s*`([^`]+?):(\d+)`/
    );

    if (headerMatch) {
      const [, emoji, severity, title, file, lineStr] = headerMatch;
      const headerEnd = trimmed.indexOf('\n');
      const body = headerEnd >= 0 ? trimmed.slice(headerEnd + 1).trim() : '';

      result.findings.push({
        severity: emoji,
        severityLabel: severity,
        title: title.trim(),
        file,
        line: parseInt(lineStr),
        body,
        raw: trimmed,
      });
    } else {
      result.findings.push({
        severity: trimmed.match(/^(🔴|🟠|🟡|🔵)/)?.[1] || '🟡',
        severityLabel: '',
        title: '',
        file: null,
        line: null,
        body: trimmed,
        raw: trimmed,
      });
    }
  }

  return result;
}
