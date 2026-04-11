import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, interactivePrompt, summaryPrompt, systemPrompt } from '../prompts.mjs';

describe('reviewPrompt XML structure', () => {
  it('wraps PR title in xml tag', () => {
    const result = reviewPrompt({ prTitle: 'test', prDescription: 'desc', diff: 'diff', isIncremental: false, fileManifest: 'files' });
    assert.ok(result.includes('<pr_title>'));
    assert.ok(result.includes('</pr_title>'));
  });

  it('wraps description in xml tag', () => {
    const result = reviewPrompt({ prTitle: 'test', prDescription: 'desc', diff: 'diff', isIncremental: false, fileManifest: 'files' });
    assert.ok(result.includes('<pr_description>'));
    assert.ok(result.includes('</pr_description>'));
  });

  it('wraps diff in xml tag', () => {
    const result = reviewPrompt({ prTitle: 'test', prDescription: 'desc', diff: 'diff', isIncremental: false, fileManifest: 'files' });
    assert.ok(result.includes('<code_diff>'));
    assert.ok(result.includes('</code_diff>'));
  });

  it('wraps changed files in xml tag', () => {
    const result = reviewPrompt({ prTitle: 'test', prDescription: 'desc', diff: 'diff', isIncremental: false, fileManifest: 'files' });
    assert.ok(result.includes('<changed_files>'));
    assert.ok(result.includes('</changed_files>'));
  });

  it('omits description tag when empty', () => {
    const result = reviewPrompt({ prTitle: 'test', prDescription: '', diff: 'diff', isIncremental: false, fileManifest: 'files' });
    assert.ok(!result.includes('<pr_description>'));
  });

  it('contains review mode instruction', () => {
    const full = reviewPrompt({ prTitle: 'test', prDescription: '', diff: 'diff', isIncremental: false, fileManifest: '' });
    assert.ok(full.includes('FULL review'));
    const incr = reviewPrompt({ prTitle: 'test', prDescription: '', diff: 'diff', isIncremental: true, fileManifest: '' });
    assert.ok(incr.includes('INCREMENTAL review'));
  });
});

describe('systemPrompt XML structure', () => {
  it('wraps conventions in xml tag when present', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: 'rule1', learnings: [], includeNitpicks: false });
    assert.ok(result.includes('<team_conventions>'));
    assert.ok(result.includes('</team_conventions>'));
  });

  it('wraps learnings in xml tag when present', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [{ rule: 'test rule' }], includeNitpicks: false });
    assert.ok(result.includes('<team_learnings>'));
    assert.ok(result.includes('</team_learnings>'));
  });

  it('omits convention tag when empty', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(!result.includes('<team_conventions>'));
  });

  it('omits learnings tag when empty', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(!result.includes('<team_learnings>'));
  });
});

describe('interactivePrompt XML structure', () => {
  it('wraps question in xml tag', () => {
    const result = interactivePrompt({ question: 'why?', prTitle: 'test', prDescription: '', diff: 'diff' });
    assert.ok(result.includes('<question>'));
    assert.ok(result.includes('</question>'));
  });

  it('wraps code context in xml tag', () => {
    const result = interactivePrompt({ question: 'why?', prTitle: 'test', prDescription: '', fileContext: 'code' });
    assert.ok(result.includes('<code_context>'));
    assert.ok(result.includes('</code_context>'));
  });

  it('wraps diff in xml tag when no fileContext', () => {
    const result = interactivePrompt({ question: 'why?', prTitle: 'test', prDescription: '', diff: 'diff' });
    assert.ok(result.includes('<code_diff>'));
  });

  it('wraps pr_title in xml tag', () => {
    const result = interactivePrompt({ question: 'why?', prTitle: 'test', prDescription: '', diff: 'diff' });
    assert.ok(result.includes('<pr_title>'));
  });
});

describe('summaryPrompt XML structure', () => {
  it('wraps title in xml tag', () => {
    const result = summaryPrompt({ prTitle: 'test', prDescription: 'desc', files: [{ filename: 'a.js', additions: 1, deletions: 0 }], diff: 'diff' });
    assert.ok(result.includes('<pr_title>'));
  });

  it('wraps changed files in xml tag', () => {
    const result = summaryPrompt({ prTitle: 'test', prDescription: '', files: [{ filename: 'a.js', additions: 1, deletions: 0 }], diff: 'diff' });
    assert.ok(result.includes('<changed_files>'));
  });

  it('wraps diff in xml tag', () => {
    const result = summaryPrompt({ prTitle: 'test', prDescription: '', files: [], diff: 'diff' });
    assert.ok(result.includes('<code_diff>'));
  });

  it('omits description tag when empty', () => {
    const result = summaryPrompt({ prTitle: 'test', prDescription: '', files: [], diff: 'diff' });
    assert.ok(!result.includes('<pr_description>'));
  });
});
