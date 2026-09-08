import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPullRequest } from '../review.mjs';
import { readCoverage, formatCoverage, planBatches } from '../coverage.mjs';

const patch = (name, count = 5, width = 30) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n` + Array.from({ length: count }, (_, i) => `+const item${i} = '${'x'.repeat(width)}';\n`).join('');
const clean = { content: '### Tóm tắt\nThe changes introduce new behavior with explicit handling of the expected inputs.\n\n### ✅ Điểm tốt\n- Changes stay within the requested scope.' };
const config = { autoReview: true, reviewBudgetMs: 10000, maxDiffLines: 10000, triggerWord: '@bot', model: 'test', language: 'en', reviewLevel: 'standard', verifyFindings: true };
function setup(diff = patch('a.ts')) {
  const pr = { number: 1, head: { sha: 'head' }, base: { sha: 'base' }, title: 'Change', body: '', state: 'open' };
  const posted = [], calls = [], reviews = [];
  const gh = {
    getPR: async () => pr, getBotLogin: async () => 'bot', getBotReviews: async () => reviews,
    getBotComments: async () => [], getCompare: async (...args) => { calls.push(args); return diff; },
    getCompareInfo: async () => ({ status: 'ahead' }), getFileContent: async () => null,
    getTreePaths: async () => [], getBotInlineComments: async () => [], postReview: async (...args) => { posted.push(args); return true; },
    postComment: async () => true,
  };
  return { pr, posted, calls, reviews, gh, event: { action: 'synchronize', before: 'unreviewed', pull_request: pr } };
}

test('reviews every line of a 90KB diff and excludes generated files', async () => {
  const s = setup(patch('a.ts', 1500, 45) + patch('package-lock.json', 500));
  const prompts = [];
  const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async messages => { prompts.push(messages[1].content); return clean; } });
  assert.equal(result.status, 'complete');
  assert.ok(prompts.length > 1);
  assert.ok(prompts.some(p => p.includes('const item1499')));
  assert.ok(prompts.every(p => !p.includes('package-lock.json')));
  assert.equal(s.posted[0][6], 'head');
  assert.equal(s.calls[0][2], 'base'); // Never trusts event.before.
});

test('partial failure resumes unfinished batches on the same head', async () => {
  const s = setup(patch('a.ts', 400, 60) + patch('b.ts', 400, 60));
  let calls = 0;
  const first = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => { if (++calls === 2) throw new Error('provider failure'); return clean; } });
  assert.equal(first.status, 'partial');
  assert.equal(first.coverage.completed.length, 1);
  s.reviews.push({ body: s.posted[0][3] });
  calls = 0;
  const second = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async messages => { if (messages[0].content.includes('senior code reviewer')) calls++; return clean; } });
  assert.equal(second.status, 'complete'); assert.equal(calls, 1);
});

test('new head revisits code from partial review; force push falls back to full', async () => {
  const s = setup();
  s.reviews.push({ body: formatCoverage('partial', { sha: 'old', baseSha: 'base', diffBase: 'base', complete: false, completed: ['x'] }, 'test') });
  await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => clean });
  assert.equal(s.calls[0][2], 'base');
  s.reviews.push({ body: formatCoverage('complete', { sha: 'old', baseSha: 'base', diffBase: 'base', complete: true, completed: [] }, 'test') });
  s.gh.getCompareInfo = async () => ({ status: 'diverged' }); s.calls.length = 0;
  await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => clean });
  assert.equal(s.calls[0][2], 'base');
});

test('stale or closed PR is never posted after model work', async () => {
  for (const change of [p => { p.head = { sha: 'new' }; }, p => { p.state = 'closed'; }]) {
    const s = setup();
    const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => { change(s.pr); return clean; } });
    assert.equal(result.status, 'stale'); assert.equal(s.posted.length, 0);
  }
});

test('budget expiry publishes incomplete coverage instead of a clean review', async () => {
  const s = setup();
  s.gh.getFileContent = async () => { await new Promise(r => setTimeout(r, 5)); return null; };
  const result = await reviewPullRequest(s.event, 'o', 'r', { ...config, reviewBudgetMs: 1 }, { gh: s.gh, chat: async () => { throw new Error('must not run'); } });
  assert.equal(result.status, 'partial');
  assert.match(s.posted[0][3], /review is incomplete/);
});

test('published inline fallback preserves findings and commit; posting failure throws', async () => {
  const s = setup();
  const finding = { content: '### Findings\n🟠 **Major — Missing guard** — `a.ts:1`\n\nAn empty input is dereferenced before the guard and throws instead of returning an empty response.' };
  s.gh.postReview = async (...args) => { s.posted.push(args); return args[5].length === 0; };
  await reviewPullRequest(s.event, 'o', 'r', { ...config, verifyFindings: false }, { gh: s.gh, chat: async () => finding });
  assert.equal(s.posted.length, 2);
  assert.match(s.posted[1][3], /Missing guard/); assert.equal(s.posted[1][6], 'head');
  s.gh.postReview = async () => false;
  await assert.rejects(reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => clean }), /Failed to publish/);
});

test('verifier failure leaves batch pending, not silently clean', async () => {
  const s = setup(); let calls = 0;
  s.gh.getFileContent = async () => 'const x = input.value;';
  const finding = { content: '### Findings\n🟠 **Major — Missing guard** — `a.ts:1`\n\nAn empty input is dereferenced before the guard and throws instead of returning an empty response.' };
  const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => { if (++calls === 1) return finding; throw new Error('verifier unavailable'); } });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.completed.length, 0);
});

test('manual review works while paused; automatic review does not', async () => {
  const s = setup(); s.gh.getBotComments = async () => [{ body: '⏸️ Auto review **paused**' }];
  assert.equal((await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh })).status, 'paused');
  assert.equal((await reviewPullRequest({ ...s.event, manual: true }, 'o', 'r', config, { gh: s.gh, chat: async () => clean })).status, 'complete');
});

test('legacy markers never establish complete coverage', () => {
  assert.equal(readCoverage('<!-- finhay-review-meta: {"sha":"old"} -->'), null);
});

test('split hunk preserves every addition and valid new line positions', () => {
  const groups = planBatches(patch('a.ts', 200, 50), 1000);
  const additions = groups.flatMap(g => g.patch.split('\n').filter(l => l.startsWith('+const')));
  assert.equal(additions.length, 200); assert.equal(new Set(additions).size, 200);
  assert.ok(groups.every(g => g.patch.length <= 1000));
  const starts = groups.map(g => Number(g.patch.match(/@@ -\d+,\d+ \+(\d+)/)[1]));
  assert.equal(starts[0], 1); assert.ok(starts.at(-1) > 180);
});

test('metadata is opt-in and concurrent author edits are preserved', async () => {
  const s = setup(); let title = s.pr.title, updates = 0;
  s.gh.getPR = async () => ({ ...s.pr, title });
  s.gh.updatePR = async () => { updates++; return true; };
  const event = { ...s.event, action: 'opened' };
  const chat = async messages => {
    if (messages[0].content.startsWith('Suggest a conventional')) {
      title = 'Author edit during generation';
      return { content: '```pr-metadata\n{"title":"feat: rewritten title","description":"New body"}\n```' };
    }
    return clean;
  };
  await reviewPullRequest(event, 'o', 'r', config, { gh: s.gh, chat });
  assert.equal(updates, 0);
  await reviewPullRequest(event, 'o', 'r', { ...config, autoFixMetadata: true }, { gh: s.gh, chat });
  assert.equal(updates, 0);
});

test('metadata applies only after successfully posting a complete review', async () => {
  const s = setup(); let updated = false;
  s.gh.updatePR = async () => { assert.equal(s.posted.length, 1); updated = true; return true; };
  const chat = async messages => messages[0].content.startsWith('Suggest a conventional')
    ? { content: '```pr-metadata\n{"title":"feat: add behavior","description":null}\n```' } : clean;
  await reviewPullRequest({ ...s.event, action: 'opened' }, 'o', 'r', { ...config, autoFixMetadata: true }, { gh: s.gh, chat });
  assert.equal(updated, true);
});

test('malformed model finding sections cannot silently become a clean review', async () => {
  const s = setup();
  const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => ({
    content: '### Tóm tắt\nSome changes.\n## Bugs\n🟠 **Major — Crash** — `a.ts:1`\nThe input is dereferenced before checking whether it is null.' }) });
  assert.equal(result.status, 'partial');
});

test('a concise clean review is complete', async () => {
  const s = setup();
  const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => ({ content: '### Findings\nNo issues found.' }) });
  assert.equal(result.status, 'complete');
});

test('resuming a partial full-review preserves its comparison base', async () => {
  const s = setup(patch('a.ts', 400, 60) + patch('b.ts', 400, 60));
  s.reviews.push({ body: formatCoverage('earlier complete', { sha: 'old', baseSha: 'base', diffBase: 'base', complete: true, completed: [] }, 'test') });
  let calls = 0;
  await reviewPullRequest({ ...s.event, action: 'opened', manual: true }, 'o', 'r', config, { gh: s.gh, chat: async () => { if (++calls === 2) throw new Error('failed'); return clean; } });
  s.reviews.push({ body: s.posted[0][3] });
  const result = await reviewPullRequest(s.event, 'o', 'r', config, { gh: s.gh, chat: async () => clean });
  assert.equal(result.status, 'complete'); assert.equal(result.coverage.diffBase, 'base');
});
