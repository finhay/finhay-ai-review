// LLM client — OpenAI-compatible API

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes per request

export async function chat(messages, { apiBase, apiKey, model, temperature = 0.1,
  maxTokens = 4096, deadline = Infinity, timeoutMs,
  fetchImpl = fetch, sleepImpl = sleep }) {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
  // V4 defaults to high-effort thinking. Reserve room for reasoning even for
  // short verifier/summary answers, and keep all attempts inside the run budget.
  const thinking = /^deepseek-v4-(pro|flash)(?:-|$)/i.test(model);
  // OpenAI reasoning models (gpt-5.x, o-series) reject `max_tokens` and any
  // non-default `temperature` with a 400. They also bill reasoning against the
  // output cap, so a 4096 cap gets eaten before any text is produced.
  const openaiReasoning = /^(?:gpt-5|o[1-9])(?:[.\-]|$)/i.test(model);
  const reasoning = thinking || openaiReasoning;
  let tokenLimit = reasoning ? Math.max(maxTokens, 32768) : maxTokens;
  const requestTimeout = timeoutMs ?? (reasoning ? 240_000 : REQUEST_TIMEOUT_MS);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('Review budget exhausted'), { usage });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(requestTimeout, remaining));
    let error;
    try {
      const res = await fetchImpl(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages,
          ...(openaiReasoning ? { max_completion_tokens: tokenLimit } : { max_tokens: tokenLimit }),
          ...(thinking ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' } : {}),
          ...(reasoning ? {} : { temperature }) }),
      });
      const body = await res.text();
      if (!res.ok) {
        error = new Error(`LLM API error ${res.status}${describeApiError(body)}`);
        error.retryable = res.status === 429 || res.status >= 500;
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 0) error.retryAfterMs = Math.min(retryAfter * 1000, 30000);
        throw error;
      }
      const data = JSON.parse(body);
      for (const key of Object.keys(usage)) {
        const value = data.usage?.[key];
        if (Number.isFinite(value) && value >= 0) usage[key] += value;
      }
      const choice = data.choices?.[0];
      // Only log bounded metadata, never response text or reasoning contents.
      const reason = ['stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource'].includes(choice?.finish_reason)
        ? choice.finish_reason : 'missing_or_unknown';
      const reasoningChars = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : 0;
      const diagnostic = `finish_reason=${reason}, reasoning_chars=${reasoningChars}, max_tokens=${tokenLimit}`;
      if (reason !== 'stop') {
        const retryable = (reason === 'length' && reasoning && tokenLimit < 65536) || reason === 'insufficient_system_resource';
        if (reason === 'length' && retryable) tokenLimit = Math.min(tokenLimit * 2, 65536);
        throw Object.assign(new Error(`LLM response incomplete (${diagnostic})`), { retryable });
      }
      const content = typeof choice?.message?.content === 'string' ? sanitizeModelOutput(choice.message.content) : '';
      if (!content.trim()) {
        throw Object.assign(new Error(`LLM returned no text (${diagnostic})`), { retryable: true });
      }
      return { content, usage };
    } catch (err) {
      error = controller.signal.aborted ? new Error('LLM request timed out before the response body completed') : err;
      error.usage = { ...usage };
      if (error.retryable === false || attempt === MAX_RETRIES - 1) throw error;
    } finally {
      clearTimeout(timer);
    }
    const wait = error.retryAfterMs || RETRY_BASE_MS * 2 ** attempt;
    if (Date.now() + wait >= deadline) throw Object.assign(new Error('Review budget exhausted'), { usage });
    await sleepImpl(wait);
  }
}

/**
 * Surface why the provider rejected the request. Error envelopes carry the
 * offending parameter, never prompt or response text, so this stays safe to
 * log — truncated in case a provider deviates from that shape.
 */
function describeApiError(body) {
  let message;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message;
  } catch {}
  if (typeof message !== 'string' || !message.trim()) return '';
  return `: ${message.trim().replace(/\s+/g, ' ').slice(0, 300)}`;
}

/**
 * Chunk a large diff into per-file segments.
 * Returns array of { filename, patch }
 */
export function chunkDiffByFile(diffText) {
  const files = [];
  const segments = diffText.split(/^diff --git /m).filter(Boolean);

  for (const segment of segments) {
    const firstLine = segment.split('\n')[0];
    const match = firstLine.match(/a\/(.*?) b\/(.*)/);
    const filename = match ? match[2] : 'unknown';

    // Skip binary, lock, generated files
    if (shouldSkipFile(filename)) continue;

    files.push({ filename, patch: 'diff --git ' + segment });
  }
  return files;
}

/**
 * Group file chunks into request-sized batches.
 * One LLM call per file does not scale — a 112-file PR is mostly small diffs
 * (median ~1.4KB), so it spent 112 round-trips where ~18 would do and blew the
 * job timeout. Packing keeps each request under the same size cap a single
 * file would have been truncated to.
 * Returns array of { filenames, patch }.
 */
export function packChunks(fileChunks, maxChars = 40000) {
  const groups = [];
  let current = null;

  for (const chunk of fileChunks) {
    if (current && current.chars + chunk.patch.length + 1 <= maxChars) {
      current.filenames.push(chunk.filename);
      current.patches.push(chunk.patch);
      current.chars += chunk.patch.length + 1;
    } else {
      // A file larger than maxChars gets its own group and must be split before packing by the review planner.
      current = {
        filenames: [chunk.filename],
        patches: [chunk.patch],
        chars: chunk.patch.length,
      };
      groups.push(current);
    }
  }

  return groups.map(g => ({ filenames: g.filenames, patch: g.patches.join('\n') }));
}

/**
 * Estimate token count (rough: 4 chars ≈ 1 token)
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Strip model artifacts that some LLMs (e.g. MiniMax) emit alongside the
 * actual response: chain-of-thought blocks, hallucinated tool-call markers,
 * and echoed system-prompt XML wrappers. Without this, those tokens get
 * posted verbatim into PR comments.
 */
export function sanitizeModelOutput(text) {
  if (!text) return '';
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '')
    .replace(/^\s*\[TOOL_CALL\][\s\S]*?(?=\n{2}|$)/gm, '')
    .replace(/<team_conventions>[\s\S]*?<\/team_conventions>/gi, '')
    .replace(/<team_learnings>[\s\S]*?<\/team_learnings>/gi, '')
    // Hallucinated tool-call envelopes: <file_contents>, <read_file>, <tool_call>, <function_calls>, <invoke>.
    // The model has no tools — these mean it was about to dump output and got cut off.
    .replace(/<(file_contents|read_file|tool_call|function_calls|invoke|antml:function_calls|antml:invoke)\b[\s\S]*?<\/\1>/gi, '')
    // Unterminated variants (truncated mid-stream) — drop from the opening tag to end.
    .replace(/<(file_contents|read_file|tool_call|function_calls|invoke|antml:function_calls|antml:invoke)\b[\s\S]*$/i, '')
    // Trailing "Let me read…/I need to see…" stubs that lead into the hallucinated XML.
    .replace(/\n+(?:Let me (?:read|examine|see|check)[^\n]*|I (?:need|want) to (?:read|see|examine|check)[^\n]*)\.?\s*$/i, '');
  return out
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldSkipFile(filename) {
  const skipPatterns = [
    /\.lock$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.snap$/,
    /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.ico$/, /\.svg$/,
    /\.woff2?$/, /\.ttf$/, /\.eot$/,
    /\.pdf$/, /\.zip$/, /\.tar\.gz$/,
    /vendor\//, /node_modules\//,
    /generated\//,
    /\.pb\.go$/, /\.pb\.java$/,  // protobuf generated
  ];
  return skipPatterns.some(p => p.test(filename));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
