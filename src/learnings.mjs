// Learnings system — team preferences learned from review feedback

import { minimatch } from './utils.mjs';

const LEARNINGS_PATH = '.github/review-learnings.json';

/**
 * Load learnings from repo
 */
export async function loadLearnings(gh, owner, repo, ref) {
  const content = await gh.getFileContent(owner, repo, LEARNINGS_PATH, ref);
  if (!content) return [];
  try {
    return JSON.parse(content);
  } catch {
    console.log('Failed to parse review-learnings.json');
    return [];
  }
}

/**
 * Filter learnings relevant to specific files
 */
export function filterLearnings(learnings, filenames) {
  return learnings.filter(l => {
    if (!l.context || l.context === 'all' || l.context === '*') return true;
    return filenames.some(f => minimatch(f, l.context));
  });
}

/**
 * Format a new learning entry
 */
export function createLearning(rule, context, addedBy) {
  return {
    rule,
    context: context || 'all',
    added_by: addedBy,
    date: new Date().toISOString().split('T')[0],
  };
}

/**
 * Generate a suggestion message asking if the user wants to save a learning
 */
export function learningConfirmationMessage(rule, context) {
  return `💡 Em nhận thấy đây có thể là team preference. Lưu lại để áp dụng cho các review sau?

> **Rule:** ${rule}
> **Scope:** \`${context}\`

Reply \`yes\` để em tạo PR thêm learning này, hoặc \`no\` để bỏ qua.`;
}
