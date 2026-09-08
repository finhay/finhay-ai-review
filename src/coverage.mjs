import { createHash } from 'node:crypto';
import { chunkDiffByFile, packChunks } from './llm.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const COVERAGE_VERSION = 2;

export function readCoverage(body) {
  try {
    const data = JSON.parse(body?.match(/^<!-- finhay-review-meta: (.+) -->/m)?.[1]);
    if (data.version !== COVERAGE_VERSION || typeof data.sha !== 'string' ||
        typeof data.baseSha !== 'string' || typeof data.diffBase !== 'string' ||
        typeof data.complete !== 'boolean' || !Array.isArray(data.completed) ||
        !data.completed.every(id => typeof id === 'string')) return null;
    return data;
  } catch { return null; }
}

// Split oversized hunks without dropping lines or inventing their positions.
// A line larger than the limit stays intact and is reported as unreviewable.
export function splitFile(chunk, maxChars) {
  if (chunk.patch.length <= maxChars) return [chunk];
  const firstHunk = chunk.patch.search(/^@@ /m);
  if (firstHunk < 0) return [chunk];
  const header = chunk.patch.slice(0, firstHunk);
  const hunks = chunk.patch.slice(firstHunk).split(/(?=^@@ )/m);
  const pieces = [];
  for (const hunk of hunks) {
    const match = hunk.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@([^\n]*)\n/);
    if (!match) throw new Error(`Malformed hunk in ${chunk.filename}`);
    let oldLine = Number(match[1]), newLine = Number(match[2]);
    let startOld = oldLine, startNew = newLine, oldCount = 0, newCount = 0;
    let lines = [], size = 0;
    const flush = () => {
      if (!lines.length) return;
      pieces.push({ filename: chunk.filename,
        patch: `${header}@@ -${startOld},${oldCount} +${startNew},${newCount} @@${match[3]}\n${lines.join('')}` });
      lines = []; size = oldCount = newCount = 0;
      startOld = oldLine; startNew = newLine;
    };
    for (const line of hunk.slice(match[0].length).match(/[^\n]*\n|[^\n]+$/g) || []) {
      if (lines.length && header.length + size + line.length + 120 > maxChars && !line.startsWith('\\')) flush();
      lines.push(line); size += line.length;
      if (line.startsWith(' ') || line.startsWith('-')) { oldLine++; oldCount++; }
      if (line.startsWith(' ') || line.startsWith('+')) { newLine++; newCount++; }
    }
    flush();
  }
  return pieces;
}

export function planBatches(diff, maxChars = 40000) {
  return packChunks(chunkDiffByFile(diff).flatMap(c => splitFile(c, maxChars)), maxChars)
    .map(group => ({ ...group, id: hash(group.patch), oversized: group.patch.length > maxChars }));
}

export function formatCoverage(content, coverage, model) {
  return `<!-- finhay-review-meta: ${JSON.stringify({ ...coverage, version: COVERAGE_VERSION, model, ts: new Date().toISOString() })} -->\n\n## 🔍 AI Code Review\n\n${content}`;
}
