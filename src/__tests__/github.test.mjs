import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBotUser, isOwnContent } from '../github.mjs';
import { helpText, formatReviewBody } from '../prompts.mjs';

describe('isBotUser', () => {
  it('detects a GitHub App bot by user type', () => {
    assert.equal(isBotUser({ login: 'finhay-ai-reviewer[bot]', type: 'Bot' }), true);
  });

  it('detects a bot by login suffix when type is missing', () => {
    assert.equal(isBotUser({ login: 'github-actions[bot]' }), true);
  });

  it('does not flag humans', () => {
    assert.equal(isBotUser({ login: 'hungvd-finhay', type: 'User' }), false);
    assert.equal(isBotUser(null), false);
  });
});

describe('isOwnContent', () => {
  it('recognises our help text, which quotes the trigger word', () => {
    assert.equal(isOwnContent(helpText('@finhay-review')), true);
  });

  it('recognises a posted review body', () => {
    assert.equal(isOwnContent(formatReviewBody('findings', 'abc123', 'model')), true);
  });

  it('recognises pause/resume markers', () => {
    assert.equal(isOwnContent('⏸️ Auto review **paused** cho PR này.'), true);
    assert.equal(isOwnContent('▶️ Auto review **resumed** cho PR này.'), true);
  });

  it('ignores unrelated comments', () => {
    assert.equal(isOwnContent('@finhay-review full review'), false);
    assert.equal(isOwnContent(''), false);
    assert.equal(isOwnContent(undefined), false);
  });
});
