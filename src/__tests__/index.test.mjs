import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeContext } from '../index.mjs';

describe('buildSafeContext', () => {
  it('prefers webhook payload over fetched data', () => {
    const webhookPR = { title: 'original title', body: 'original body' };
    const fetchedPR = { title: 'modified title', body: 'modified body', head: { sha: 'abc' } };
    const ctx = buildSafeContext(webhookPR, fetchedPR);
    assert.equal(ctx.title, 'original title');
    assert.equal(ctx.body, 'original body');
    assert.equal(ctx.headSha, 'abc');
  });

  it('falls back to fetched data when webhook field is missing', () => {
    const webhookPR = { title: 'original' };
    const fetchedPR = { title: 'fetched', body: 'fetched body', head: { sha: 'abc' } };
    const ctx = buildSafeContext(webhookPR, fetchedPR);
    assert.equal(ctx.title, 'original');
    assert.equal(ctx.body, 'fetched body');
  });

  it('works with only webhook data (no fetched)', () => {
    const webhookPR = { title: 'title', body: 'body', number: 42, head: { sha: 'xyz', ref: 'main' } };
    const ctx = buildSafeContext(webhookPR);
    assert.equal(ctx.title, 'title');
    assert.equal(ctx.body, 'body');
    assert.equal(ctx.number, 42);
    assert.equal(ctx.headSha, 'xyz');
  });

  it('handles null body in webhook gracefully', () => {
    const webhookPR = { title: 'title', body: null };
    const fetchedPR = { title: 'fetched', body: 'fetched body', head: { sha: 'abc' } };
    const ctx = buildSafeContext(webhookPR, fetchedPR);
    // null ?? fallback triggers, so it falls back to fetched body
    assert.equal(ctx.body, 'fetched body');
  });
});
