import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFinding, applyVerdict, loadFindingContext } from '../quality.mjs';
const f = { file: 'controller.ts', line: 2, severity: '🟠', severityLabel: 'Major', title: 'Missing guard', body: 'The input is null.', raw: 'The input is null.' };
const contexts = [{ path: 'controller.ts', start: 1, end: 2, source: 'const account = login(input);\nreturn account.id;', text: '' }];

test('rejects explicit no-action findings and anchored formatting comments', () => {
  assert.equal(cleanFinding({ ...f, title: 'Note (không cần fix)' }), null);
  assert.equal(cleanFinding({ ...f, title: 'Whitespace/formatting' }), null);
});
test('removes no-op suggestions and disallows incomplete code fences', () => {
  const text = '```suggestion\nreturn account.id;\n```';
  assert.equal(cleanFinding({ ...f, raw: text, body: text }, contexts[0].source).body, '');
  assert.throws(() => cleanFinding({ ...f, raw: '```suggestion\nunfinished' }), /Incomplete/);
});
test('multi-line suggestions are shown for manual application, never applied to one line', () => {
  const text = '```suggestion\nconst x = 1;\nreturn x;\n```';
  const result = cleanFinding({ ...f, raw: text, body: text });
  assert.ok(!result.body.includes('```suggestion'));
  assert.match(result.body, /apply manually/);
});
test('verification must cite exact visible source and cannot increase severity', () => {
  const response = { verdict: 'keep', severity: 'Critical', reason: 'Null input reaches account.id.', evidence: [{ path: 'controller.ts', line: 2, quote: 'return account.id;' }] };
  assert.equal(applyVerdict(f, contexts, JSON.stringify(response)).finding.severityLabel, 'Major');
  response.evidence[0].quote = 'invented source';
  assert.throws(() => applyVerdict(f, contexts, JSON.stringify(response)), /unavailable source/);
});
test('uncertain findings do not remain Major inline comments', () => {
  const result = applyVerdict(f, contexts, JSON.stringify({ verdict: 'uncertain', reason: 'Caller contract is not visible.' }));
  assert.equal(result.finding, null); assert.match(result.verify, /Caller contract/);
});
test('context retrieves relevant callee from repository paths, not just the diff', async () => {
  const sources = { 'controller.ts': "import { service } from '@services';\nreturn userService.login(input).id;", 'src/UserService.ts': 'async login(input) {\n  throw new Error();\n}' };
  const result = await loadFindingContext({ ...f, raw: 'userService.login() may return null' }, {
    readFile: async path => sources[path], paths: Object.keys(sources),
  });
  assert.ok(result.some(c => c.path === 'src/UserService.ts'));
});
