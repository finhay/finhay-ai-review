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
    assert.ok(/prescribed `###` sections/.test(result));
  });

  it('tells the reviewer to drop self-refuting findings instead of explaining them away', () => {
    const result = systemPrompt({ language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false });
    assert.ok(/talk yourself out of|non-issue|delete the finding/i.test(result));
  });
});

describe('systemPrompt evidence gate (false-positive guards)', () => {
  const build = (over = {}) => systemPrompt({
    language: 'vi', reviewLevel: 'standard', conventions: '', learnings: [], includeNitpicks: false, ...over,
  });

  it('requires every finding to name a sink and a concrete failure', () => {
    const result = build();
    assert.ok(result.includes('Evidence Gate'));
    assert.ok(/Name the sink/.test(result));
  });

  it('caps unverifiable findings below Major and routes them to Cần verify', () => {
    const result = build();
    assert.ok(/NEVER be 🔴 Critical or 🟠 Major/.test(result));
    assert.ok(result.includes('### Cần verify'));
  });

  it('states that removing a pure super.foo() delegation is not a regression', () => {
    const result = build();
    assert.ok(/return `?super\.foo/.test(result));
    assert.ok(/Deleted code is not automatically a regression/.test(result));
  });

  it('scopes path traversal away from flat key-value keyspaces', () => {
    const result = build();
    assert.ok(/Path traversal/.test(result));
    assert.ok(/Redis, Memcached, DynamoDB keys/.test(result));
    assert.ok(/hard-coded literal in the source cannot be escaped/.test(result));
  });

  it('warns about reading the diff backwards', () => {
    const result = build();
    assert.ok(/`-` lines are the OLD code/.test(result));
    assert.ok(/read the diff backwards/.test(result));
  });

  it('forbids reporting findings the model itself says need no action', () => {
    const result = build();
    assert.ok(/không cần fix/.test(result));
    assert.ok(/nobody should act on is noise/.test(result));
  });

  it('blocks hedged wording from carrying a Major label', () => {
    const result = build();
    assert.ok(/load-bearing in your explanation, it is NOT Major/.test(result));
    assert.ok(result.includes('Finding Self-Check'));
  });

  it('lists high-value bug classes including single-use/idempotency', () => {
    const result = build();
    assert.ok(result.includes('High-Value Checks'));
    assert.ok(/Single-use \/ idempotency/.test(result));
    assert.ok(/Money & precision/.test(result));
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
