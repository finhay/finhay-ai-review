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

describe('systemPrompt incremental mode', () => {
  it('asks for a full 2-3 sentence Tóm tắt on full review', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false, isIncremental: false });
    assert.ok(result.includes('2-3 sentences summarizing'));
    assert.ok(!result.includes('OMIT this section entirely'));
  });

  it('makes Tóm tắt optional on incremental review', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false, isIncremental: true });
    assert.ok(result.includes('Only include this section if NEW changes'));
    assert.ok(result.includes('OMIT this section entirely'));
    assert.ok(!result.includes('2-3 sentences summarizing'));
  });
});

describe('systemPrompt tool-call drift guards', () => {
  it('forbids tool-call markers and file-fetch envelopes', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(result.includes('<file_contents>'));
    assert.ok(result.includes('[TOOL_CALL]'));
    assert.ok(/Let me read|I need to see/.test(result));
    assert.ok(/no tools|NO tools/i.test(result));
  });

  it('forbids free-form section headers like ## Analysis or per-file ###', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(result.includes('## Analysis'));
    assert.ok(/three prescribed/.test(result));
  });

  it('tells the reviewer to drop self-refuting findings instead of explaining them away', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(/talk yourself out of|non-issue|delete the finding/i.test(result));
  });
});

describe('systemPrompt autoFixMetadata gate', () => {
  it('includes PR Title & Description Auto-fix block by default', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(result.includes('PR Title & Description Auto-fix'));
    assert.ok(result.includes('```pr-metadata'));
    assert.ok(result.includes('### PR Metadata'));
  });

  it('omits auto-fix block when autoFixMetadata is false', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false, autoFixMetadata: false });
    assert.ok(!result.includes('PR Title & Description Auto-fix'));
    assert.ok(!result.includes('```pr-metadata'));
    assert.ok(!result.includes('### PR Metadata'));
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
