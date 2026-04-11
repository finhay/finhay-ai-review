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
        content: data.choices?.[0]?.message?.content || '',
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
 * Estimate token count (rough: 4 chars ≈ 1 token)
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
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
