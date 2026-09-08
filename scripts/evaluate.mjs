import { readFile } from 'node:fs/promises';
import { chat } from '../src/llm.mjs';
import { cleanFinding, verificationMessages, applyVerdict } from '../src/quality.mjs';

// Fixtures are deliberately minimized reproductions, not copied private files.
const cases = JSON.parse(await readFile(new URL('../evals/cases.json', import.meta.url), 'utf8'));
const live = process.argv.includes('--live');
if (live && (!process.env.EVAL_API_KEY || !process.env.EVAL_API_BASE || !process.env.EVAL_MODEL)) {
  throw new Error('Live replay requires EVAL_API_KEY, EVAL_API_BASE and EVAL_MODEL');
}
const rows = [];
for (const entry of cases) {
  const f = entry.finding;
  const finding = { ...f, raw: `${f.severity} **${f.severityLabel} — ${f.title}** — \`${f.file}:${f.line}\`\n\n${f.body}` };
  const source = entry.sources[f.file];
  const cleaned = cleanFinding(finding, source);
  if (!live) {
    const deterministic = cleaned ? 'requires-model-verification' : 'dropped';
    const removedSuggestion = !!cleaned && finding.raw.includes('```suggestion') && !cleaned.raw.includes('```suggestion');
    rows.push({ id: entry.id, deterministic, removedSuggestion,
      pass: deterministic === entry.expectedOffline.deterministic && removedSuggestion === entry.expectedOffline.removedSuggestion });
    continue;
  }
  try {
    let result = { finding: null };
    if (cleaned) {
      const contexts = Object.entries(entry.sources).map(([path, source]) => ({ path, source, start: 1, end: source.split('\n').length,
        text: source.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n') }));
      const response = await chat(verificationMessages(cleaned, contexts), {
        apiBase: process.env.EVAL_API_BASE, apiKey: process.env.EVAL_API_KEY, model: process.env.EVAL_MODEL,
        maxTokens: 2000, deadline: Date.now() + 120000,
      });
      result = applyVerdict(cleaned, contexts, response.content);
    }
    const actual = result.finding ? 'keep' : result.verify ? 'uncertain' : 'drop';
    const order = ['Nitpick', 'Minor', 'Major', 'Critical'];
    const severityOK = !result.finding || order.indexOf(result.finding.severityLabel) <= order.indexOf(entry.maxSeverity);
    rows.push({ id: entry.id, expected: entry.expectedVerdict, actual, severity: result.finding?.severityLabel,
      pass: actual === entry.expectedVerdict && severityOK });
  } catch (err) { rows.push({ id: entry.id, pass: false, error: err.message }); }
}
console.log(JSON.stringify({ mode: live ? 'live-verifier-replay' : 'offline-filter-check',
  model: live ? process.env.EVAL_MODEL : null, cases: rows,
  note: 'Diagnostic minimized cases; not a production precision or recall estimate.' }, null, 2));
if (rows.some(row => !row.pass)) process.exitCode = 1;
