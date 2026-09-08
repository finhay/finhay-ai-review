import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as gh from '../github.mjs';
import { chat } from '../llm.mjs';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
afterEach(() => gh.setRuntime());

test('GitHub paginates files, reviews and pause state beyond 100 entries', async () => {
  gh.init('test');
  const urls = [];
  gh.setRuntime({ fetch: async url => {
    urls.push(url);
    return new URL(url).searchParams.get('page') === '1' ? json(Array.from({ length: 100 }, () => ({ user: { login: 'human' } })), 200, { link: '<next>; rel="next"' })
      : json([{ filename: 'last.ts', user: { login: 'bot' }, body: '▶️ Auto review **resumed**' }]);
  } });
  assert.equal((await gh.getPRFiles('o', 'r', 1)).length, 101);
  assert.equal((await gh.getBotReviews('o', 'r', 1, 'bot')).length, 1);
  assert.match((await gh.getBotComments('o', 'r', 1, 'bot'))[0].body, /resumed/);
  assert.equal(urls.length, 6);
});

test('GitHub exhausted reads throw and ambiguous writes are never replayed', async () => {
  let calls = 0;
  gh.init('test'); gh.setRuntime({ fetch: async () => { calls++; return json({}, 503); }, sleep: async () => {} });
  await assert.rejects(gh.getCompare('o', 'r', 'a', 'b'), /exhausted retries/);
  assert.equal(calls, 3); calls = 0;
  await assert.rejects(gh.postReview('o', 'r', 1, 'review'), /exhausted retries/);
  assert.equal(calls, 1);
});

test('file reads encode paths and refs; permission failures are not missing files', async () => {
  gh.init('test'); let seen;
  gh.setRuntime({ fetch: async url => { seen = url; return json({}, 403); } });
  await assert.rejects(gh.getFileContent('o', 'r', 'a#b.ts', 'feature/a&b'), /403/);
  assert.match(seen, /a%23b.ts\?ref=feature%2Fa%26b/);
});

test('LLM permanent errors do not retry; throttling exhausts with explicit error', async () => {
  let calls = 0;
  const config = { apiBase: 'https://example.test', apiKey: 'test', model: 'test', sleepImpl: async () => {} };
  await assert.rejects(chat([], { ...config, fetchImpl: async () => { calls++; return json({}, 401); } }), /401/);
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(chat([], { ...config, fetchImpl: async () => { calls++; return json({}, 429); } }), /429/);
  assert.equal(calls, 3);
});

test('LLM rejects truncated output and observes deadline before another call', async () => {
  const config = { apiBase: 'https://example.test', apiKey: 'test', model: 'test' };
  await assert.rejects(chat([], { ...config, fetchImpl: async () => json({ choices: [{ message: { content: 'unfinished' }, finish_reason: 'length' }] }) }), /incomplete/);
  await assert.rejects(chat([], { ...config, deadline: Date.now() - 1, fetchImpl: () => assert.fail('must not call') }), /budget/);
});

test('LLM timeout covers stalled response body, not just headers', async () => {
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls++;
    return { ok: true, text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('body aborted')))) };
  };
  await assert.rejects(chat([], { apiBase: 'https://example.test', model: 'test', timeoutMs: 5, fetchImpl, sleepImpl: async () => {} }), /body aborted/);
  assert.equal(calls, 3);
});
