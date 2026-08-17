// LLM client — OpenAI-compatible API

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes per request

export async function chat(messages, { apiBase, apiKey, model, temperature = 0.1, maxTokens = 4096 }) {
  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        console.log(`LLM API ${res.status}, retry in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
      }

      const data = await res.json();
      return {
        content: sanitizeModelOutput(data.choices?.[0]?.message?.content || ''),
        usage: data.usage || {},
      };
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      console.log(`LLM request failed: ${err.message}, retry in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Chunk a large diff into per-file segments.
 * Returns array of { filename, patch }
 */
export function chunkDiffByFile(diffText) {
  const files = [];
  const filePattern = /^diff --git a\/(.*?) b\/(.*?)$/gm;
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
    if (current && current.chars + chunk.patch.length <= maxChars) {
      current.filenames.push(chunk.filename);
      current.patches.push(chunk.patch);
      current.chars += chunk.patch.length;
    } else {
      // A file larger than maxChars gets its own group and is truncated by the caller.
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
