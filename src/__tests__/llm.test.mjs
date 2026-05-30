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
});
