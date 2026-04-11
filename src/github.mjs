// GitHub API helpers — native fetch, zero deps

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

let _token, _apiBase;

export function init(token, apiBase = 'https://api.github.com') {
  _token = token;
  _apiBase = apiBase;
}

async function ghFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${_apiBase}${path}`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${_token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const wait = Math.min(reset - Date.now(), 60000);
        console.log(`GitHub rate limited, waiting ${wait}ms`);
        await sleep(Math.max(wait, 1000));
        continue;
      }
      if (res.status >= 500) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
}

/**
 * Get PR diff as text
 */
export async function getPRDiff(owner, repo, prNumber) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { 'Accept': 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) {
    console.error(`Failed to fetch PR diff: ${res.status} ${res.statusText}`);
    return '';
  }
  return res.text();
}

/**
 * Get PR metadata
 */
export async function getPR(owner, repo, prNumber) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  return res.ok ? res.json() : null;
}

/**
 * Get changed files list
 */
export async function getPRFiles(owner, repo, prNumber) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  return res.ok ? res.json() : [];
}

/**
 * Get diff between two commits (for incremental review)
 */
export async function getCompare(owner, repo, baseSha, headSha) {
  const res = await ghFetch(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`, {
    headers: { 'Accept': 'application/vnd.github.v3.diff' },
  });
  if (!res.ok) {
    console.error(`Failed to fetch compare diff: ${res.status} ${res.statusText}`);
    return '';
  }
  return res.text();
}

/**
 * Post a PR review (proper review, not just comment)
 * event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
 */
export async function postReview(owner, repo, prNumber, body, event = 'COMMENT', comments = []) {
  const payload = { body, event };
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
  return res.ok;
}

/**
 * Reply to a review comment
 */
export async function replyToReviewComment(owner, repo, prNumber, commentId, body) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return res.ok;
}

async function fetchBotItems(apiPath, botLogin) {
  const res = await ghFetch(`${apiPath}?per_page=100`);
  if (!res.ok) return [];
  const items = await res.json();
  return items.filter(item => item.user?.login === botLogin);
}

export async function getBotReviews(owner, repo, prNumber, botLogin) {
  return fetchBotItems(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, botLogin);
}

export async function getBotComments(owner, repo, issueNumber, botLogin) {
  return fetchBotItems(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, botLogin);
}

export async function getComment(owner, repo, commentId) {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`);
  return res.ok ? res.json() : null;
}

export async function getReviewComment(owner, repo, commentId) {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/comments/${commentId}`);
  return res.ok ? res.json() : null;
}

/**
 * Get file content from repo
 */
export async function getFileContent(owner, repo, path, ref = 'HEAD') {
  const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  return data.content || null;
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
