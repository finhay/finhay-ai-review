#!/usr/bin/env node
// Finhay AI Review — Entry point

import * as gh from './github.mjs';
import { chat, chunkDiffByFile, estimateTokens, packChunks } from './llm.mjs';
import {
  systemPrompt, reviewPrompt, interactivePrompt, summaryPrompt,
  learningDetectionPrompt, formatReviewBody, helpText, fixPrompt,
} from './prompts.mjs';
import { loadLearnings, filterLearnings, learningConfirmationMessage } from './learnings.mjs';
import { parseCommand, isPaused } from './commands.mjs';
import { getInput, parseRepo, readEventPayload, countDiffLines, truncate, sanitize, parseDiffMap, parseFindings, extractPRMetadata, hasMeaningfulContent, reconcilePath, filterGenericFindings, isMergeCommitPush } from './utils.mjs';

// Reviews carry a summary, findings with suggestion blocks, and a trailing
// pr-metadata JSON block — the 4096 default truncated them mid-finding, which
// also strands the metadata block and silently disables the title/description
// auto-fix.
const REVIEW_MAX_TOKENS = 8192;

/**
 * Build a safe PR context that prefers webhook payload data (captured at trigger time)
 * over fetched data, preventing TOCTOU attacks where attackers edit PR content
 * between trigger and processing.
 */
export function buildSafeContext(webhookPR, fetchedPR = null) {
  const merged = fetchedPR || webhookPR;
  return {
    title: webhookPR.title ?? merged.title,
    body: webhookPR.body ?? merged.body ?? '',
    headSha: merged.head?.sha,
    headRef: merged.head?.ref,
    number: webhookPR.number ?? merged.number,
    raw: merged,
  };
}

async function main() {
  // --- Load config ---
  const config = {
    model: getInput('model', 'MiniMax-M2.7'),
    apiBase: getInput('api_base', 'https://api.minimaxi.chat/v1'),
    apiKey: getInput('api_key'),
    triggerWord: getInput('trigger_word', '@finhay-review'),
    autoReview: getInput('auto_review', 'true') === 'true',
    maxDiffLines: parseInt(getInput('max_diff_lines', '10000')),
    language: getInput('language', 'vi'),
    reviewLevel: getInput('review_level', 'standard'),
    includeNitpicks: getInput('include_nitpicks', 'false') === 'true',
    conventionsFile: getInput('conventions_file', '.github/review-conventions.md'),
    // Stop starting new LLM batches past this point so the review still gets
    // posted before the workflow's timeout-minutes kills the job.
    reviewBudgetMs: parseInt(getInput('review_budget_minutes', '10')) * 60_000,
    githubToken: getInput('github_token') || process.env.GITHUB_TOKEN,
  };

  if (!config.apiKey) {
    console.error('❌ api_key is required');
    process.exit(1);
  }

  if (!config.githubToken) {
    console.warn('⚠️ No GitHub token found. API calls will likely fail.');
  }

  gh.init(config.githubToken);
  const { owner, repo } = parseRepo();
  const event = await readEventPayload();
  const eventName = process.env.GITHUB_EVENT_NAME;

  console.log(`Event: ${eventName}, Repo: ${owner}/${repo}`);

  try {
    if (eventName === 'pull_request') {
      await handlePullRequest(event, owner, repo, config);
    } else if (eventName === 'issue_comment') {
      await handleIssueComment(event, owner, repo, config);
    } else if (eventName === 'pull_request_review_comment') {
      await handleReviewComment(event, owner, repo, config);
    } else {
      console.log(`Unhandled event: ${eventName}`);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// ===== PR opened/synchronize =====
async function handlePullRequest(event, owner, repo, config) {
  if (!config.autoReview) {
    console.log('Auto review disabled, skipping');
    return;
  }

  const pr = event.pull_request;
  const safeCtx = buildSafeContext(pr);
  const safeTitle = sanitize(safeCtx.title);
  const safeBody = sanitize(safeCtx.body);
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const botLogin = await gh.getBotLogin();

  console.log(`PR #${prNumber}: ${safeCtx.title} (${event.action})`);

  // Check if paused
  const [botReviews, botComments] = await Promise.all([
    gh.getBotReviews(owner, repo, prNumber, botLogin),
    gh.getBotComments(owner, repo, prNumber, botLogin),
  ]);
  if (isPaused(botComments)) {
    console.log(`PR #${prNumber} is paused, skipping auto review`);
    return;
  }

  // Skip auto-review when the push is just a merge from the base branch.
  // Manual `@finhay-review review` sets event.manual=true to bypass this.
  if (event.action === 'synchronize' && !event.manual) {
    const headCommit = await gh.getCommit(owner, repo, headSha);
    if (isMergeCommitPush(headCommit)) {
      console.log(`Head ${headSha.slice(0, 7)} is a merge commit, skipping auto review`);
      return;
    }
  }

  // Determine if incremental or full review
  let isIncremental = false;
  let lastSha = null;

  if (event.action === 'synchronize') {
    // Prefer: last reviewed SHA from bot review body (covers reviews since last push)
    for (let i = botReviews.length - 1; i >= 0; i--) {
      lastSha = gh.extractLastReviewedSha(botReviews[i].body);
      if (lastSha) break;
    }

    // Fallback: use the synchronize event's 'before' SHA.
    // This handles cases where getBotReviews returns empty (e.g. bot login mismatch
    // after switching to a GitHub App token) or no SHA is embedded in the review body.
    if (!lastSha && event.before && event.before !== '0000000000000000000000000000000000000000') {
      lastSha = event.before;
      console.log(`No reviewed SHA found in bot reviews; using event.before as incremental base`);
    }

    if (lastSha) isIncremental = true;
  }

  // Get diff
  let diff;
  let fullDiff; // Always keep full PR diff for inline comment positioning
  if (isIncremental && lastSha) {
    console.log(`Incremental review: ${lastSha}...${headSha}`);
    const [incrementalDiff, prDiff] = await Promise.all([
      gh.getCompare(owner, repo, lastSha, headSha),
      gh.getPRDiff(owner, repo, prNumber),
    ]);
    diff = incrementalDiff;
    fullDiff = prDiff;
  } else {
    console.log('Full review');
    diff = await gh.getPRDiff(owner, repo, prNumber);
    fullDiff = diff;
  }

  if (!diff || diff.trim().length === 0) {
    console.log('Empty diff, skipping');
    return;
  }

  const lines = countDiffLines(diff);
  if (lines > config.maxDiffLines) {
    await gh.postComment(owner, repo, prNumber,
      `⚠️ PR quá lớn (${lines.toLocaleString()} lines) — vượt giới hạn auto review (${config.maxDiffLines.toLocaleString()}).\n\nDùng \`${config.triggerWord} review\` để review thủ công, hoặc chia PR nhỏ hơn.`);
    return;
  }

  // Load conventions + learnings
  const [conventions, prFiles, allLearnings] = await Promise.all([
    loadConventions(owner, repo, pr.head.ref, config),
    gh.getPRFiles(owner, repo, prNumber),
    loadLearnings(gh, owner, repo, pr.head.ref),
  ]);
  const filenames = prFiles.map(f => f.filename);
  const relevantLearnings = filterLearnings(allLearnings, filenames);
  const fileManifest = buildFileManifest(prFiles);

  // Build context from previous reviews so the LLM knows what was already flagged
  let previousReviewSummary = '';
  if (isIncremental && botReviews.length > 0) {
    const bodies = botReviews
      .slice(-3) // last 3 reviews max
      .map(r => r.body?.replace(/<!-- finhay-review-meta:.*?-->\n?/s, '').replace(/^## 🔍 AI Code Review\n\n/, '').trim())
      .filter(Boolean);
    if (bodies.length > 0) {
      previousReviewSummary = truncate(bodies.join('\n\n---\n\n'), 4000);
    }
  }

  // Chunk diff into per-file segments — also filters generated/lock/binary files.
  // If nothing reviewable remains (e.g. push only touched package-lock.json),
  // skip without posting.
  const fileChunks = chunkDiffByFile(diff);
  if (fileChunks.length === 0) {
    console.log('No reviewable files after filtering (lockfiles/binaries/generated only), skipping');
    return;
  }

  // Build prompts. Only ask the model to regenerate the PR title/description
  // on PR open — otherwise we spend tokens every push and risk rewriting an
  // already-good title.
  const autoFixMetadata = event.action === 'opened';
  const buildSysPrompt = (overrides = {}) => systemPrompt({
    language: config.language,
    reviewLevel: config.reviewLevel,
    conventions,
    learnings: relevantLearnings,
    includeNitpicks: config.includeNitpicks,
    isIncremental,
    autoFixMetadata,
    ...overrides,
  });
  const sysPrompt = buildSysPrompt();

  let reviewContent;

  let skippedFiles = 0;

  if (estimateTokens(diff) > 30000) {
    // Review in packed batches, merge results
    const groups = packChunks(fileChunks, 15000);
    console.log(`Large diff (${fileChunks.length} files) — ${groups.length} review requests`);
    const CONCURRENCY = 5;
    const deadline = Date.now() + config.reviewBudgetMs;
    const results = new Array(groups.length);
    let done = 0;
    // A batch sees a handful of files — far too little to retitle the PR from.
    // Metadata is derived once at the end, from the whole-PR view.
    const batchSysPrompt = buildSysPrompt({ autoFixMetadata: false });

    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      // Stop issuing work before the job timeout kills us mid-flight — a partial
      // review that gets posted beats a complete one that never does.
      if (Date.now() > deadline) {
        skippedFiles = groups.slice(i).reduce((n, g) => n + g.filenames.length, 0);
        console.log(`⏱️ Review budget reached — posting ${done}/${groups.length} batches, ${skippedFiles} file(s) not reviewed`);
        break;
      }

      const batch = groups.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (group, j) => {
        const userMsg = reviewPrompt({
          prTitle: safeTitle,
          prDescription: safeBody,
          diff: truncate(group.patch, 15000),
          isIncremental,
          fileManifest,
          previousReviewSummary,
          fullPRDiff: isIncremental ? truncate(fullDiff, 30000) : undefined,
          batch: { index: i + j + 1, total: groups.length },
        });
        const label = describeGroup(group);
        try {
          const res = await chat(
            [{ role: 'system', content: batchSysPrompt }, { role: 'user', content: userMsg }],
            { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, maxTokens: REVIEW_MAX_TOKENS }
          );
          results[i + j] = `#### ${label}\n${res.content}`;
        } catch (err) {
          console.error(`Failed to review ${label}: ${err.message}`);
          results[i + j] = `#### ${label}\n⚠️ Review failed for these files.`;
        }
      });
      await Promise.all(promises);
      done += batch.length;
      console.log(`Reviewed ${done}/${groups.length} batches (${Math.round((Date.now() - (deadline - config.reviewBudgetMs)) / 1000)}s elapsed)`);
    }
    reviewContent = results.filter(Boolean).join('\n\n---\n\n');

    // One summary for the whole PR. Batches are told not to write their own —
    // each only sees a few files, so merging them produced N paraphrases of the
    // same paragraph and a PR title rewritten from an arbitrary slice.
    const overview = await summarizePR({
      sysPrompt: buildSysPrompt(),
      prTitle: safeTitle,
      prDescription: safeBody,
      files: prFiles,
      diff,
      config,
    });
    if (overview) reviewContent = `### Tóm tắt\n${overview}\n\n${reviewContent}`;
  } else {
    // Single review
    const userMsg = reviewPrompt({
      prTitle: safeTitle,
      prDescription: safeBody,
      diff: truncate(diff, 60000),
      isIncremental,
      fileManifest,
      previousReviewSummary,
      fullPRDiff: isIncremental ? truncate(fullDiff, 30000) : undefined,
    });
    const res = await chat(
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, maxTokens: REVIEW_MAX_TOKENS }
    );
    reviewContent = res.content;
    console.log(`Tokens: ${JSON.stringify(res.usage)}`);
  }

  if (!hasMeaningfulContent(reviewContent)) {
    console.log('LLM returned empty/non-substantive review, skipping post');
    return;
  }

  // Extract and apply PR metadata auto-fix
  const prMeta = extractPRMetadata(reviewContent);
  if (prMeta.title || prMeta.description) {
    const updated = await gh.updatePR(owner, repo, prNumber, {
      title: prMeta.title,
      description: prMeta.description,
    });
    if (updated) {
      console.log(`📝 PR metadata updated${prMeta.title ? ` — title: "${prMeta.title}"` : ''}${prMeta.description ? ' — description updated' : ''}`);
    }
  }
  reviewContent = prMeta.cleanContent;

  // Parse findings for inline comments (use full PR diff for line positioning)
  const { inlineComments, reviewBody } = buildInlineComments(reviewContent, fullDiff, { includeNitpicks: config.includeNitpicks });
  const partialNotice = skippedFiles > 0
    ? `\n\n> ⏱️ PR lớn — ${skippedFiles} file chưa được review trong lượt này (hết ngân sách thời gian). Chạy lại \`${config.triggerWord} full review\` để review tiếp, hoặc tăng \`review_budget_minutes\`.`
    : '';
  let body = formatReviewBody(reviewBody + partialNotice, headSha, config.model);

  // Try with inline comments, fall back to body-only if GitHub rejects them
  let posted = inlineComments.length > 0
    ? await gh.postReview(owner, repo, prNumber, body, 'COMMENT', inlineComments)
    : false;

  if (!posted && inlineComments.length > 0) {
    console.log('Inline comments rejected by GitHub, retrying without inline comments');
    body = formatReviewBody(reviewContent + partialNotice, headSha, config.model);
  }

  if (!posted) {
    posted = await gh.postReview(owner, repo, prNumber, body, 'COMMENT');
  }

  console.log(posted
    ? `✅ Review posted for PR #${prNumber} (${inlineComments.length} inline comments)`
    : `❌ Failed to post review for PR #${prNumber}`);
}

// ===== Issue/PR comment with @trigger =====
async function handleIssueComment(event, owner, repo, config) {
  const comment = event.comment;
  const issue = event.issue;

  // Skip bot-authored comments. Our own help text lists the trigger word, so a
  // login check that misses (App tokens can't read /user) makes the bot answer
  // itself — and each self-reply spawns a run that cancels the real one.
  if (gh.isBotUser(comment.user)) return;

  // Only handle PR comments (issues have no pull_request key)
  if (!issue.pull_request) return;

  const cmd = parseCommand(comment.body, config.triggerWord);
  if (!cmd) return;

  const prNumber = issue.number;
  console.log(`Command: ${cmd.type} on PR #${prNumber}`);

  switch (cmd.type) {
    case 'help':
      await gh.postComment(owner, repo, prNumber, helpText(config.triggerWord));
      break;

    case 'pause':
      await gh.postComment(owner, repo, prNumber, '⏸️ Auto review **paused** cho PR này. Dùng `' + config.triggerWord + ' resume` để bật lại.');
      break;

    case 'resume':
      await gh.postComment(owner, repo, prNumber, '▶️ Auto review **resumed** cho PR này.');
      break;

    case 'resolve':
      await gh.postComment(owner, repo, prNumber, '✅ Đã resolve tất cả review comments.');
      break;

    case 'review':
    case 'full_review': {
      const pr = await gh.getPR(owner, repo, prNumber);
      if (!pr) break;
      // Reuse handlePullRequest logic, preserving webhook title/body to prevent TOCTOU
      const fakeEvent = {
        action: cmd.type === 'full_review' ? 'opened' : 'synchronize',
        manual: true,
        pull_request: {
          ...pr,
          title: issue.title ?? pr.title,
          body: issue.body ?? pr.body,
        },
      };
      await handlePullRequest(fakeEvent, owner, repo, { ...config, autoReview: true });
      break;
    }

    case 'summary': {
      const [pr, files, summaryDiff] = await Promise.all([
        gh.getPR(owner, repo, prNumber),
        gh.getPRFiles(owner, repo, prNumber),
        gh.getPRDiff(owner, repo, prNumber),
      ]);
      // Use webhook issue data (TOCTOU-safe) for title/body sent to LLM
      const summaryCtx = buildSafeContext(issue, pr);
      const userMsg = summaryPrompt({ prTitle: sanitize(summaryCtx.title), prDescription: sanitize(summaryCtx.body), files, diff: truncate(summaryDiff, 15000), language: config.language });
      const res = await chat(
        [{ role: 'system', content: 'You are a helpful PR summarizer. Write in Vietnamese.' }, { role: 'user', content: userMsg }],
        { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.3 }
      );
      await gh.postComment(owner, repo, prNumber, `## 📋 Tóm tắt PR\n\n${res.content}`);
      break;
    }

    case 'chat': {
      const [pr, diff] = await Promise.all([
        gh.getPR(owner, repo, prNumber),
        gh.getPRDiff(owner, repo, prNumber),
      ]);
      // Use webhook issue data (TOCTOU-safe) for title/body sent to LLM
      const chatCtx = buildSafeContext(issue, pr);
      const userMsg = interactivePrompt({
        question: cmd.args,
        prTitle: sanitize(chatCtx.title),
        prDescription: sanitize(chatCtx.body),
        diff: truncate(diff, 15000),
      });
      const sysPrompt = systemPrompt({
        language: config.language,
        reviewLevel: config.reviewLevel,
        conventions: await loadConventions(owner, repo, pr.head.ref, config),
        learnings: [],
        includeNitpicks: false,
      });
      const res = await chat(
        [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
        { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.5 }
      );
      await gh.postComment(owner, repo, prNumber, res.content);
      break;
    }
  }
}

// ===== Review comment reply (inline code comment) =====
async function handleReviewComment(event, owner, repo, config) {
  const comment = event.comment;
  if (gh.isBotUser(comment.user)) return;

  const cmd = parseCommand(comment.body, config.triggerWord);
  if (!cmd) {
    // Check if this is a reply to our review comment → learning detection
    await detectLearning(event, owner, repo, config);
    return;
  }

  const prNumber = event.pull_request.number;

  if (cmd.type === 'fix') {
    const pr = event.pull_request;
    // Get the bot's original finding (parent comment in the thread)
    const parentComment = comment.in_reply_to_id
      ? await gh.getReviewComment(owner, repo, comment.in_reply_to_id)
      : null;
    const finding = parentComment?.body || comment.diff_hunk || '';
    const filename = comment.path || parentComment?.path || '';

    let fileContent = '';
    if (filename) {
      fileContent = await gh.getFileContent(owner, repo, filename, pr.head.ref) || '';
    }

    const userMsg = fixPrompt({
      finding,
      fileContent: truncate(fileContent, 10000),
      filename,
    });
    const res = await chat(
      [
        { role: 'system', content: `You are a precise code fixer. Generate minimal fixes using GitHub suggestion blocks. Answer in ${config.language === 'vi' ? 'Vietnamese' : 'English'}.` },
        { role: 'user', content: userMsg },
      ],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.2 }
    );
    await gh.replyToReviewComment(owner, repo, prNumber, comment.id, res.content);
  } else if (cmd.type === 'chat') {
    const pr = event.pull_request;
    const safeCtx = buildSafeContext(pr);
    const userMsg = interactivePrompt({
      question: cmd.args,
      prTitle: sanitize(safeCtx.title),
      prDescription: sanitize(safeCtx.body),
      fileContext: comment.diff_hunk || '',
    });
    const res = await chat(
      [
        { role: 'system', content: `You are a helpful code reviewer assistant. Answer in ${config.language === 'vi' ? 'Vietnamese' : 'English'}.` },
        { role: 'user', content: userMsg },
      ],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.5 }
    );
    await gh.replyToReviewComment(owner, repo, prNumber, comment.id, res.content);
  }
}

// ===== Learning detection =====
async function detectLearning(event, owner, repo, config) {
  const comment = event.comment;
  const prNumber = event.pull_request.number;

  if (!comment.in_reply_to_id) return;

  const userReply = comment.body;
  if (!userReply || userReply.length < 20) return;

  // Fetch the parent comment to get the actual bot review text
  const parentComment = await gh.getReviewComment(owner, repo, comment.in_reply_to_id);
  // Parent must be a bot review comment — under an App token the login lookup
  // can't confirm which bot, so bot-authored is the strongest check available.
  if (!parentComment || !gh.isBotUser(parentComment.user)) return;

  const prompt = learningDetectionPrompt({
    botComment: parentComment.body,
    userReply,
    codeContext: comment.diff_hunk || '',
  });

  try {
    const res = await chat(
      [{ role: 'system', content: 'Extract team learnings from code review feedback.' }, { role: 'user', content: prompt }],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.1, maxTokens: 500 }
    );

    const output = res.content.trim();
    if (output.includes('NO_LEARNING')) return;

    const ruleMatch = output.match(/LEARNING:\s*(.+)/);
    const contextMatch = output.match(/CONTEXT:\s*(.+)/);
    if (!ruleMatch) return;

    const rule = ruleMatch[1].trim();
    const context = contextMatch ? contextMatch[1].trim() : 'all';

    await gh.replyToReviewComment(owner, repo, prNumber, comment.id,
      learningConfirmationMessage(rule, context));
  } catch (err) {
    console.log(`Learning detection failed: ${err.message}`);
  }
}

// ===== Helpers =====

function buildInlineComments(reviewContent, diff, { includeNitpicks = false } = {}) {
  const parsed = parseFindings(reviewContent);
  parsed.findings = filterGenericFindings(parsed.findings, { includeNitpicks });

  // Nothing recognisable — post the model's text as-is rather than an empty body.
  if (!parsed.summary && !parsed.verify && !parsed.positives && parsed.findings.length === 0) {
    return { inlineComments: [], reviewBody: reviewContent };
  }

  const diffMap = parseDiffMap(diff);
  const diffFiles = new Set(diffMap.keys());
  const inlineComments = [];
  const bodyFindings = [];

  for (const original of parsed.findings) {
    const reconciled = reconcilePath(original, diffFiles);
    const finding = { ...original, file: reconciled.file, raw: reconciled.raw };

    if (finding.file && finding.line && diffMap.get(finding.file)?.has(finding.line)) {
      const commentBody = finding.title
        ? `${finding.severity} **${finding.severityLabel} — ${finding.title}**\n\n${finding.body}`
        : finding.raw;
      inlineComments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: commentBody,
      });
    } else {
      bodyFindings.push(finding.raw);
    }
  }

  const parts = [];
  if (parsed.summary) parts.push(`### Tóm tắt\n${parsed.summary}`);
  if (bodyFindings.length > 0) {
    parts.push(`### Findings\n${bodyFindings.join('\n\n')}`);
  } else if (inlineComments.length > 0) {
    parts.push(`### Findings\n_${inlineComments.length} finding(s) posted as inline comments below._`);
  } else {
    parts.push('### Findings\n_Không có finding nào ở mức 🔴/🟠/🟡._');
  }
  if (parsed.verify) parts.push(`### Cần verify\n${parsed.verify}`);
  if (parsed.positives) parts.push(`### ✅ Điểm tốt\n${capLines(parsed.positives, 10)}`);

  const reviewBody = parts.length > 0 ? parts.join('\n\n') : reviewContent;
  return { inlineComments, reviewBody };
}

async function loadConventions(owner, repo, ref, config) {
  const paths = [
    config.conventionsFile,
    'CLAUDE.md',
    '.cursorrules',
    'CONVENTIONS.md',
    '.github/copilot-instructions.md',
  ];

  // Fetch all in parallel, use first match (by priority order)
  const results = await Promise.all(
    paths.map(p => gh.getFileContent(owner, repo, p, ref).then(content => ({ path: p, content })))
  );

  for (const { path, content } of results) {
    if (content) {
      console.log(`Loaded conventions from: ${path}`);
      return truncate(content, 5000);
    }
  }
  return '';
}

// 21 batches each contribute praise, and 31 bullets of it buries the items that
// actually need attention.
function capLines(text, max) {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join('\n')}\n- _… và ${lines.length - max} mục khác._`;
}

// Whole-PR overview for a batched review: the manifest plus a truncated diff is
// a far better basis for the summary (and the PR title/description auto-fix)
// than any single batch. Never fail the review over it.
async function summarizePR({ sysPrompt, prTitle, prDescription, files, diff, config }) {
  try {
    const res = await chat(
      [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: summaryPrompt({ prTitle, prDescription, files, diff: truncate(diff, 15000), language: config.language }) },
      ],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.3, maxTokens: REVIEW_MAX_TOKENS }
    );
    // The system prompt defines a `### Tóm tắt` section, so the model often
    // emits the heading despite being asked for bare text — we add our own.
    return res.content.trim().replace(/^###\s*(Tóm tắt|Summary)\s*\n/i, '').trim();
  } catch (err) {
    console.error(`Failed to build PR summary: ${err.message}`);
    return '';
  }
}

// Heading for a packed batch — keep it short, a batch can hold a dozen files.
function describeGroup(group) {
  const [first, ...rest] = group.filenames;
  return rest.length > 0 ? `${first} +${rest.length} file(s)` : first;
}

function buildFileManifest(prFiles) {
  const EXT_LANG = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript/React', '.js': 'JavaScript', '.jsx': 'JavaScript/React',
    '.py': 'Python', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
    '.rb': 'Ruby', '.rs': 'Rust', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML',
    '.sql': 'SQL', '.sh': 'Shell', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON',
  };
  const lines = prFiles.map(f => {
    const ext = f.filename.match(/\.[^.]+$/)?.[0] || '';
    const lang = EXT_LANG[ext] || '';
    const status = f.status === 'added' ? 'new' : f.status === 'removed' ? 'deleted' : 'modified';
    return `- ${f.filename} (${status}, +${f.additions}/-${f.deletions})${lang ? ` — ${lang}` : ''}`;
  });
  return lines.join('\n');
}


// Only auto-run in GitHub Actions context (allows test imports without triggering main)
if (process.env.GITHUB_EVENT_PATH) main();
