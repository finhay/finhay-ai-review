import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as gh from '../github.mjs';
import { handleIssueComment, handleReviewComment } from '../index.mjs';
import { learningConfirmationMessage } from '../learnings.mjs';
import { minimatch, parseDiffMap, extractPRMetadata } from '../utils.mjs';
afterEach(() => gh.setRuntime());

test('pause/resume/help execute writes, resolve explicitly reports unsupported', async () => {
  gh.init('test'); const posts = [];
  gh.setRuntime({ fetch: async (_url, options) => { posts.push(JSON.parse(options.body).body); return new Response('{}', { status: 201 }); } });
  for (const command of ['pause', 'resume', 'help', 'resolve']) {
    await handleIssueComment({ issue: { number: 1, pull_request: {} }, comment: { user: { type: 'User' }, body: `@bot ${command}` } }, 'o', 'r', { triggerWord: '@bot' });
  }
  assert.match(posts[0], /paused/); assert.match(posts[1], /resumed/);
  assert.match(posts[2], /Commands/); assert.match(posts[3], /not supported/);
  assert.ok(!posts[3].includes('✅'));
});

test('bot comments never cause command or learning calls', async () => {
  gh.setRuntime({ fetch: () => assert.fail('must not fetch') });
  const event = { comment: { user: { type: 'Bot' }, body: '@bot review' }, issue: { pull_request: {} } };
  await handleIssueComment(event, 'o', 'r', { triggerWord: '@bot' });
  await handleReviewComment(event, 'o', 'r', { triggerWord: '@bot' });
});

test('learning suggestion makes no promise to save on yes', () => {
  const message = learningConfirmationMessage('Use early returns', 'src/*');
  assert.ok(message.includes('chưa tự lưu')); assert.ok(!message.includes('Reply `yes`'));
});

test('glob patterns escape regex syntax and globstar matches zero directories', () => {
  assert.equal(minimatch('src/a.ts', 'src/**/*.ts'), true);
  assert.equal(minimatch('src/deep/a.ts', 'src/**/*.ts'), true);
  assert.equal(minimatch('src/[id]/a.ts', 'src/[id]/*.ts'), true);
  assert.equal(minimatch('src/i/a.ts', 'src/[id]/*.ts'), false);
});

test('diff map excludes file headers and handles plus/minus source lines', () => {
  const map = parseDiffMap('diff --git a/a.ts b/a.ts\nindex 1..2\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n---old\n+++new\n');
  assert.deepEqual([...map.get('a.ts')], [1]);
});

test('metadata rejects nonstrings and oversized titles', () => {
  for (const title of [{ x: 1 }, 'x'.repeat(300), 'title\nnewline']) {
    const result = extractPRMetadata('```pr-metadata\n' + JSON.stringify({ title }) + '\n```');
    assert.equal(result.title, null);
  }
});

test('fix replies use the thread root and suppress unchanged suggestions', async () => {
  gh.init('test'); let replyUrl, replyBody;
  gh.setRuntime({ fetch: async (url, options) => {
    if (url.endsWith('/pulls/comments/10')) return Response.json({ body: 'Review finding', path: 'a.ts' });
    if (url.includes('/contents/')) return Response.json({ encoding: 'base64', content: Buffer.from('return value;').toString('base64') });
    replyUrl = url; replyBody = JSON.parse(options.body).body;
    return Response.json({}, { status: 201 });
  } });
  await handleReviewComment({ pull_request: { number: 1, head: { sha: 'head' } },
    comment: { id: 20, in_reply_to_id: 10, path: 'a.ts', body: '@bot fix', user: { type: 'User' } } },
    'o', 'r', { triggerWord: '@bot', language: 'en' }, { callChat: async () => ({ content: '```suggestion\nreturn value;\n```' }) });
  assert.match(replyUrl, /comments\/10\/replies$/);
  assert.equal(replyBody, 'No applicable code change was generated.');
});
