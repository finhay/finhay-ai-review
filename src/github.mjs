// GitHub API helpers — native fetch, zero deps

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

let _token, _apiBase, _botLogin;

export function init(token, apiBase = 'https://api.github.com') {
  _token = token;
  _apiBase = apiBase;
  _botLogin = null;
}

// Markers we stamp on everything we post. GitHub App installation tokens cannot
// call `GET /user` (403 "Resource not accessible by integration"), so getBotLogin
// silently falls back to `github-actions[bot]` and never matches `<app>[bot]`.
// Content matching is the reliable identity check under an App token.
const OWN_CONTENT_MARKERS = [
  '<!-- finhay-review-meta:',
  '## 🔍 AI Code Review',
  '## 🤖 Finhay Review — Commands',
  '⏸️ Auto review **paused**',
  '▶️ Auto review **resumed**',
];

/** True if `body` was written by this action. */
export function isOwnContent(body) {
  return OWN_CONTENT_MARKERS.some(marker => (body || '').includes(marker));
}

/** True for any bot account — used to avoid replying to (and looping on) bot comments. */
export function isBotUser(user) {
  return user?.type === 'Bot' || /\[bot\]$/.test(user?.login || '');
}

/**
 * Get the authenticated bot login (cached after first call).
 * Works with GITHUB_TOKEN (github-actions[bot]); GitHub App installation tokens
 * cannot read /user, so this falls back — pair it with isBotUser/isOwnContent.
 */
export async function getBotLogin() {
  if (_botLogin) return _botLogin;
  try {
    const res = await ghFetch('/user');
    if (res.ok) {
      const data = await res.json();
      _botLogin = data.login;
      return _botLogin;
    }
  } catch { /* fall through */ }
  _botLogin = 'github-actions[bot]';
  return _botLogin;
}

let runtime = {};
export function setRuntime(overrides = {}) { runtime = overrides; }

async function ghFetch(path, options = {}) {
  const url = `${_apiBase}${path}`;
  const readOnly = !options.method || options.method === 'GET';
  const attempts = readOnly ? MAX_RETRIES : 1; // Never replay an ambiguously successful write.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await (runtime.fetch || fetch)(url, {
        ...options,
        signal: AbortSignal.timeout(runtime.timeoutMs || 30000),
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${_token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });
      const body = await res.text();
      const retryable = res.status >= 500 || res.status === 429 ||
        (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if (retryable) {
        if (attempt === attempts - 1) throw Object.assign(new Error(`GitHub API exhausted retries: ${res.status}`), { final: true });
        await (runtime.sleep || sleep)(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      return new Response(res.status === 204 ? null : body, { status: res.status, headers: res.headers });
    } catch (err) {
      if (err.final || attempt === attempts - 1) throw err;
      await (runtime.sleep || sleep)(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

function requireOK(res) {
  if (!res.ok) throw new Error(`GitHub API failed: ${res.status}`);
  return res;
}

async function getAll(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const res = requireOK(await ghFetch(`${path}?per_page=100&page=${page}`));
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Expected a GitHub list response');
    items.push(...batch);
    if (!res.headers.get('link')?.includes('rel="next"')) return items;
  }
}

export async function getCompareInfo(owner, repo, baseSha, headSha) {
  const res = await ghFetch(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}?per_page=1`);
  if (res.status === 404) return null;
  return requireOK(res).json();
}

export async function getBotInlineComments(owner, repo, number, botLogin) {
  return (await getAll(`/repos/${owner}/${repo}/pulls/${number}/comments`))
    .filter(item => item.user?.login === botLogin || (isBotUser(item.user) && item.body?.includes('<!-- finhay-finding:')));
}

export async function getTreePaths(owner, repo, sha) {
  const data = await requireOK(await ghFetch(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`)).json();
  // A partial tree is usable for context, but never represents review coverage.
  return data.tree.filter(item => item.type === 'blob').map(item => item.path);
}

/**
 * Get PR diff as text
 */
export async function getPRDiff(owner, repo, prNumber) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { 'Accept': 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) {
    requireOK(res);
  }
  return res.text();
}

/**
 * Get PR metadata
 */
export async function getPR(owner, repo, prNumber) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (res.status === 404) return null;
  return requireOK(res).json();
}

/**
 * Get changed files list
 */
export async function getPRFiles(owner, repo, prNumber) {
  return getAll(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
}

/**
 * Get a commit's metadata (message + parents). Used to detect merge commits.
 * Returns { message, parents } or null on failure.
 */
export async function getCommit(owner, repo, sha) {
  const res = await ghFetch(`/repos/${owner}/${repo}/commits/${sha}`);
  if (res.status === 404) return null;
  const data = await requireOK(res).json();
  return {
    message: data.commit?.message || '',
    parents: data.parents || [],
  };
}

/**
 * Get diff between two commits (for incremental review)
 */
export async function getCompare(owner, repo, baseSha, headSha) {
  const res = await ghFetch(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`, {
    headers: { 'Accept': 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) {
    requireOK(res);
  }
  return res.text();
}

/**
 * Post a PR review (proper review, not just comment)
 * event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
 */
export async function postReview(owner, repo, prNumber, body, event = 'COMMENT', comments = [], commitId) {
  const payload = { body, event, ...(commitId ? { commit_id: commitId } : {}) };
  if (comments.length > 0) {
    payload.comments = comments;
  }
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to post review: ${res.status} ${err.slice(0, 300)}`);
  }
  return res.ok;
}

/**
 * Post an issue/PR comment
 */
export async function postComment(owner, repo, issueNumber, body) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to post comment: ${res.status} ${err.slice(0, 300)}`);
  }
  requireOK(res);
  return true;
}

/**
 * Reply to a review comment
 */
export async function replyToReviewComment(owner, repo, prNumber, commentId, body) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  requireOK(res);
  return true;
}

async function fetchBotItems(apiPath, botLogin) {
  const items = await getAll(apiPath);
  // Login match covers GITHUB_TOKEN; marker match covers App tokens whose login
  // we can't resolve. Without the fallback these return [] and the caller loses
  // pause state and the last-reviewed SHA.
  return items.filter(item =>
    item.user?.login === botLogin || (isBotUser(item.user) && isOwnContent(item.body)));
}

export async function getBotReviews(owner, repo, prNumber, botLogin) {
  return fetchBotItems(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, botLogin);
}

export async function getBotComments(owner, repo, issueNumber, botLogin) {
  return fetchBotItems(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, botLogin);
}

export async function getComment(owner, repo, commentId) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`);
  if (res.status === 404) return null;
  return requireOK(res).json();
}

export async function getReviewComment(owner, repo, commentId) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/comments/${commentId}`);
  if (res.status === 404) return null;
  return requireOK(res).json();
}

/**
 * Get file content from repo
 */
export async function getFileContent(owner, repo, path, ref = 'HEAD') {
  const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  const data = await requireOK(res).json();
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  return data.content || null;
}

/**
 * Update PR title and/or description
 */
export async function updatePR(owner, repo, prNumber, { title, description }) {
  const payload = {};
  if (title) payload.title = title;
  if (description) payload.body = description;
  if (Object.keys(payload).length === 0) return true;

  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to update PR: ${res.status} ${err.slice(0, 300)}`);
  }
  return res.ok;
}

/**
 * Update a review body (e.g., to mark as outdated)
 */
export async function updateReview(owner, repo, prNumber, reviewId, body) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  });
  return res.ok;
}

/**
 * Minimize (hide) a comment
 */
export async function minimizeComment(owner, repo, commentNodeId) {
  // GraphQL mutation to minimize comment
  const query = `mutation { minimizeComment(input: {subjectId: "${commentNodeId}", classifier: OUTDATED}) { minimizedComment { isMinimized } } }`;
  await ghFetch('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

/**
 * Extract last reviewed SHA from bot's review body
 */
export function extractLastReviewedSha(reviewBody) {
  const match = reviewBody?.match(/<!-- finhay-review-meta: ({.*?}) -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).sha;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
