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
 * Parse review markdown into structured findings for inline comments.
 * Returns { summary, findings: [{ severity, severityLabel, title, file, line, body, raw }], positives }
 */
export function parseFindings(reviewContent) {
  const result = { summary: '', findings: [], positives: '' };

  const summaryMatch = reviewContent.match(/###\s*Tóm tắt\n([\s\S]*?)(?=###|$)/);
  if (summaryMatch) result.summary = summaryMatch[1].trim();

  const positivesMatch = reviewContent.match(/###\s*✅\s*Điểm tốt\n([\s\S]*?)(?=###|$)/);
  if (positivesMatch) result.positives = positivesMatch[1].trim();

  const findingsMatch = reviewContent.match(/###\s*Findings\n([\s\S]*?)(?=###\s*✅|$)/);
  if (!findingsMatch) return result;

  const findingBlocks = findingsMatch[1].split(/(?=^(?:🔴|🟠|🟡|🔵))/m);

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
