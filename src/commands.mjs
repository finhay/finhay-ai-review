// Command parser for @finhay-review mentions

/**
 * Parse a comment body for commands
 * Returns { type, args } or null if no trigger found
 */
export function parseCommand(body, triggerWord = '@finhay-review') {
  if (!body) return null;

  const trigger = triggerWord.toLowerCase();
  const lower = body.toLowerCase().trim();

  if (!lower.includes(trigger)) return null;

  // Extract text after trigger word
  const idx = lower.indexOf(trigger);
  const after = body.slice(idx + triggerWord.length).trim();
  const afterLower = after.toLowerCase();

  // Match commands
  if (afterLower === 'pause') return { type: 'pause' };
  if (afterLower === 'resume') return { type: 'resume' };
  if (afterLower === 'help') return { type: 'help' };
  if (afterLower === 'resolve') return { type: 'resolve' };
  if (afterLower === 'fix') return { type: 'fix' };
  if (afterLower.startsWith('full review')) return { type: 'full_review' };
  if (afterLower === 'review') return { type: 'review' };
  if (afterLower === 'summary') return { type: 'summary' };

  // Everything else is a question/chat
  if (after.length > 0) return { type: 'chat', args: after };

  // Just the trigger word alone = help
  return { type: 'help' };
}

/**
 * Check if a PR has been paused via a bot comment
 */
export function isPaused(botComments) {
  // Look for most recent pause/resume in bot comments
  for (let i = botComments.length - 1; i >= 0; i--) {
    const body = botComments[i].body || '';
    if (body.includes('⏸️ Auto review **paused**')) return true;
    if (body.includes('▶️ Auto review **resumed**')) return false;
  }
  return false;
}
