import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelOutput } from '../llm.mjs';

describe('sanitizeModelOutput', () => {
  it('returns empty string for null/undefined/empty input', () => {
    assert.equal(sanitizeModelOutput(''), '');
    assert.equal(sanitizeModelOutput(null), '');
    assert.equal(sanitizeModelOutput(undefined), '');
  });

  it('strips a closed <think> block', () => {
    const input = '<think>internal reasoning here</think>\n## Review\n\nFindings...';
    assert.equal(sanitizeModelOutput(input), '## Review\n\nFindings...');
  });

  it('strips multi-line <think> block', () => {
    const input = '<think>\nstep 1\nstep 2\n</think>\n\nactual output';
    assert.equal(sanitizeModelOutput(input), 'actual output');
  });

  it('strips an unterminated <think> block', () => {
    const input = 'before\n<think>truncated reasoning never closes\nand more';
    assert.equal(sanitizeModelOutput(input), 'before');
  });

  it('strips [TOOL_CALL]...[/TOOL_CALL] blocks', () => {
    const input = '[TOOL_CALL]\n{tool => "gitnexus_context", args => {name: "X"}}\n[/TOOL_CALL]\n\nactual content';
    assert.equal(sanitizeModelOutput(input), 'actual content');
  });

  it('strips multiple back-to-back [TOOL_CALL] blocks', () => {
    const input = '[TOOL_CALL]\nfoo\n[/TOOL_CALL]\n[TOOL_CALL]\nbar\n[/TOOL_CALL]\nresult';
    assert.equal(sanitizeModelOutput(input), 'result');
  });

  it('strips echoed <team_conventions> wrapper', () => {
    const input = '<team_conventions>\nlocal rules\n</team_conventions>\n\nreal review body';
    assert.equal(sanitizeModelOutput(input), 'real review body');
  });

  it('strips echoed <team_learnings> wrapper', () => {
    const input = '<team_learnings>\n- rule 1\n</team_learnings>\nfindings here';
    assert.equal(sanitizeModelOutput(input), 'findings here');
  });

  it('handles mixed artifacts in one response', () => {
    const input = '<think>thinking</think>\n[TOOL_CALL]\nfake\n[/TOOL_CALL]\n\n## Review\n\nbody';
    assert.equal(sanitizeModelOutput(input), '## Review\n\nbody');
  });

  it('collapses excessive blank lines left behind', () => {
    const input = '<think>x</think>\n\n\n\n\nafter';
    assert.equal(sanitizeModelOutput(input), 'after');
  });

  it('passes clean input through unchanged (modulo trim)', () => {
    const input = '## Review\n\nFindings...\n';
    assert.equal(sanitizeModelOutput(input), '## Review\n\nFindings...');
  });

  it('strips a closed <file_contents> envelope', () => {
    const input = '### Findings\n\nbody\n\n<file_contents>\n<path>src/foo.ts</path>\n</file_contents>';
    const out = sanitizeModelOutput(input);
    assert.ok(!out.includes('<file_contents>'));
    assert.ok(!out.includes('<path>'));
    assert.ok(out.includes('### Findings'));
  });

  it('strips an unterminated <file_contents> envelope (mid-stream cutoff)', () => {
    const input = '### Findings\n\nbody\n\n<file_contents>\n<path>src/foo.ts</path>\n';
    const out = sanitizeModelOutput(input);
    assert.ok(!out.includes('<file_contents>'));
    assert.ok(!out.includes('<path>'));
    assert.ok(out.includes('### Findings'));
  });

  it('strips multiple <file_contents> envelopes back-to-back', () => {
    const input = '<file_contents>\n<path>a</path>\n</file_contents>\n<file_contents>\n<path>b</path>\n</file_contents>\n\nactual';
    assert.equal(sanitizeModelOutput(input), 'actual');
  });

  it('strips <tool_call> and <function_calls> envelopes', () => {
    assert.equal(
      sanitizeModelOutput('<tool_call>\nread foo.ts\n</tool_call>\n\nreview body'),
      'review body'
    );
    assert.equal(
      sanitizeModelOutput('<function_calls>\n<invoke name="Read">x</invoke>\n</function_calls>\n\nreview body'),
      'review body'
    );
  });

  it('strips trailing "Let me read…" stubs that lead into hallucinated XML', () => {
    const input = '### 3. wifeed-vn-agri.collector.ts\n\nLet me examine this file carefully.';
    const out = sanitizeModelOutput(input);
    assert.ok(!out.includes('Let me examine'));
    assert.ok(out.includes('### 3.'));
  });

  it('strips the real broken-review shape from PR #372 (second comment)', () => {
    // Reproduces the actual broken output: prose ends with "I need to see..." then hallucinated tags.
    const input = `## Analysis

### 1. file.ts

body

---

I need to see the full content of the new collector and modified files to give an accurate review. Let me read the relevant files.

<file_contents>
<path>apps/api/src/collectors/commodities/wifeed-vn-agri.collector.ts</path>
</file_contents>
<file_contents>
<path>apps/api/src/collectors/commodities/wifeed-vn-commodities.collector.ts</path>
</file_contents>`;
    const out = sanitizeModelOutput(input);
    assert.ok(!out.includes('<file_contents>'));
    assert.ok(!out.includes('<path>'));
    assert.ok(!out.includes('I need to see'));
    assert.ok(!out.includes('Let me read'));
    assert.ok(out.includes('## Analysis'));
  });
});
