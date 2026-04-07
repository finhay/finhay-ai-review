#!/usr/bin/env node
// Finhay AI Review — Entry point

import * as gh from './github.mjs';
import { chat, chunkDiffByFile, estimateTokens } from './llm.mjs';
import {
  systemPrompt, reviewPrompt, interactivePrompt, summaryPrompt,
  learningDetectionPrompt, formatReviewBody, helpText, fixPrompt,
} from './prompts.mjs';
import { loadLearnings, filterLearnings, learningConfirmationMessage } from './learnings.mjs';
import { parseCommand, isPaused } from './commands.mjs';
import { getInput, parseRepo, readEventPayload, countDiffLines, truncate, sanitize, parseDiffMap, parseFindings } from './utils.mjs';

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
    githubToken: process.env.GITHUB_TOKEN,
  };

  if (!config.apiKey) {
    console.error('❌ api_key is required');
    process.exit(1);
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
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const botLogin = getBotLogin();

  console.log(`PR #${prNumber}: ${pr.title} (${event.action})`);

  // Check if paused
  const [botReviews, botComments] = await Promise.all([
    gh.getBotReviews(owner, repo, prNumber, botLogin),
    gh.getBotComments(owner, repo, prNumber, botLogin),
  ]);
  if (isPaused(botComments)) {
    console.log(`PR #${prNumber} is paused, skipping auto review`);
    return;
  }

  // Determine if incremental or full review
  let isIncremental = false;
  let lastSha = null;

  if (event.action === 'synchronize' && botReviews.length > 0) {
    // Find last reviewed SHA
    for (let i = botReviews.length - 1; i >= 0; i--) {
      lastSha = gh.extractLastReviewedSha(botReviews[i].body);
      if (lastSha) break;
    }
    if (lastSha) isIncremental = true;
  }

  // Get diff
  let diff;
  if (isIncremental && lastSha) {
    console.log(`Incremental review: ${lastSha}...${headSha}`);
    diff = await gh.getCompare(owner, repo, lastSha, headSha);
  } else {
    console.log('Full review');
    diff = await gh.getPRDiff(owner, repo, prNumber);
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

  // Build prompts
  const sysPrompt = systemPrompt({
    language: config.language,
    reviewLevel: config.reviewLevel,
    conventions,
    learnings: relevantLearnings,
    includeNitpicks: config.includeNitpicks,
  });

  // Chunk if needed
  const fileChunks = chunkDiffByFile(diff);
  let reviewContent;

  if (estimateTokens(diff) > 30000) {
    // Review per file, merge results
    console.log(`Large diff (${fileChunks.length} files), reviewing per file`);
    const CONCURRENCY = 5;
    const results = new Array(fileChunks.length);
    for (let i = 0; i < fileChunks.length; i += CONCURRENCY) {
      const batch = fileChunks.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (chunk, j) => {
        const userMsg = reviewPrompt({
          prTitle: sanitize(pr.title),
          prDescription: sanitize(pr.body || ''),
          diff: truncate(chunk.patch, 15000),
          isIncremental,
          fileManifest,
        });
        try {
          const res = await chat(
            [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
            { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model }
          );
          results[i + j] = `#### ${chunk.filename}\n${res.content}`;
        } catch (err) {
          console.error(`Failed to review ${chunk.filename}: ${err.message}`);
          results[i + j] = `#### ${chunk.filename}\n⚠️ Review failed for this file.`;
        }
      });
      await Promise.all(promises);
    }
    reviewContent = results.join('\n\n---\n\n');
  } else {
    // Single review
    const userMsg = reviewPrompt({
      prTitle: sanitize(pr.title),
      prDescription: sanitize(pr.body || ''),
      diff: truncate(diff, 60000),
      isIncremental,
      fileManifest,
    });
    const res = await chat(
      [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model }
    );
    reviewContent = res.content;
    console.log(`Tokens: ${JSON.stringify(res.usage)}`);
  }

  // Parse findings for inline comments
  const { inlineComments, reviewBody } = buildInlineComments(reviewContent, diff);
  let body = formatReviewBody(reviewBody, headSha, config.model);

  // Try with inline comments, fall back to body-only if GitHub rejects them
  let posted = inlineComments.length > 0
    ? await gh.postReview(owner, repo, prNumber, body, 'COMMENT', inlineComments)
    : false;

  if (!posted && inlineComments.length > 0) {
    console.log('Inline comments rejected by GitHub, retrying without inline comments');
    body = formatReviewBody(reviewContent, headSha, config.model);
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

  // Skip bot's own comments
  if (comment.user.login === getBotLogin()) return;

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
      // Reuse handlePullRequest logic
      const fakeEvent = {
        action: cmd.type === 'full_review' ? 'opened' : 'synchronize',
        pull_request: pr,
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
      const userMsg = summaryPrompt({ prTitle: sanitize(pr.title), prDescription: sanitize(pr.body), files, diff: truncate(summaryDiff, 15000) });
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
      const userMsg = interactivePrompt({
        question: cmd.args,
        prTitle: sanitize(pr.title),
        prDescription: sanitize(pr.body),
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
  if (comment.user.login === getBotLogin()) return;

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
    const userMsg = interactivePrompt({
      question: cmd.args,
      prTitle: sanitize(pr.title),
      prDescription: sanitize(pr.body),
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
  if (!parentComment || parentComment.user?.login !== getBotLogin()) return;

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

function buildInlineComments(reviewContent, diff) {
  const parsed = parseFindings(reviewContent);
  if (parsed.findings.length === 0) {
    return { inlineComments: [], reviewBody: reviewContent };
  }

  const diffMap = parseDiffMap(diff);
  const inlineComments = [];
  const bodyFindings = [];

  for (const finding of parsed.findings) {
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
  }
  if (parsed.positives) parts.push(`### ✅ Điểm tốt\n${parsed.positives}`);

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

function getBotLogin() {
  return 'github-actions[bot]';
}

main();
