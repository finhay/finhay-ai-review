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
