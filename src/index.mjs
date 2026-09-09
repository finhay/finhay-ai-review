#!/usr/bin/env node
// Finhay AI Review — Entry point

import * as gh from './github.mjs';
import { chat } from './llm.mjs';
import { pathToFileURL } from 'node:url';
import { reviewPullRequest, loadConventions as readConventions } from './review.mjs';
import {
  systemPrompt, interactivePrompt, summaryPrompt,
  learningDetectionPrompt, helpText, fixPrompt,
} from './prompts.mjs';
import { cleanFinding } from './quality.mjs';
import { learningConfirmationMessage } from './learnings.mjs';
import { parseCommand } from './commands.mjs';
import { getInput, parseRepo, readEventPayload, truncate, sanitize } from './utils.mjs';

/**
 * Prefer event-time title/body for conversational context. This is not a
 * prompt-injection defense or an atomic guard against concurrent PR edits.
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

export async function main() {
  // --- Load config ---
  const config = {
    model: getInput('model', 'MiniMax-M2.7'),
    apiBase: getInput('api_base', 'https://api.minimaxi.chat/v1'),
    apiKey: getInput('api_key'),
    triggerWord: getInput('trigger_word', '@finhay-review'),
    autoReview: getInput('auto_review', 'true') === 'true',
    maxDiffLines: positiveInput('max_diff_lines', 10000),
    language: getInput('language', 'vi'),
    reviewLevel: getInput('review_level', 'standard'),
    includeNitpicks: getInput('include_nitpicks', 'false') === 'true',
    conventionsFile: getInput('conventions_file', '.github/review-conventions.md'),
    // Stop starting new LLM batches past this point so the review still gets
    // posted before the workflow's timeout-minutes kills the job.
    reviewBudgetMs: positiveInput('review_budget_minutes', 10) * 60_000,
    verifyFindings: getInput('verify_findings', 'true') === 'true',
    autoFixMetadata: getInput('auto_fix_metadata', 'false') === 'true',
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
    if (eventName === 'pull_request' || eventName === 'pull_request_target') {
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

// Review orchestration is separately injectable for event-level tests.
export const handlePullRequest = reviewPullRequest;

// ===== Issue/PR comment with @trigger =====
export async function handleIssueComment(event, owner, repo, config) {
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
      await gh.postComment(owner, repo, prNumber, 'ℹ️ Automatic thread resolution is not supported. Resolve threads in GitHub; no threads were changed.');
      break;

    case 'review':
    case 'full_review': {
      const pr = await gh.getPR(owner, repo, prNumber);
      if (!pr) break;
      // Preserve event-time title/body when triggering the review pipeline.
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
      // Use event-time issue title/body for the model context.
      const summaryCtx = buildSafeContext(issue, pr);
      const userMsg = summaryPrompt({ prTitle: sanitize(summaryCtx.title), prDescription: sanitize(summaryCtx.body), files, diff: truncate(summaryDiff, 15000), language: config.language });
      const res = await chat(
        [{ role: 'system', content: `You are a helpful PR summarizer. Write in ${config.language === 'vi' ? 'Vietnamese' : 'English'}.` }, { role: 'user', content: userMsg }],
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
      // Use event-time issue title/body for the model context.
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
        conventions: await loadConventions(owner, repo, pr.base.sha, config),
        learnings: [],
        includeNitpicks: false,
        autoFixMetadata: false,
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
export async function handleReviewComment(event, owner, repo, config, { callChat = chat } = {}) {
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
      fileContent = await gh.getFileContent(owner, repo, filename, pr.head.sha) || '';
    }

    const userMsg = fixPrompt({
      finding,
      fileContent: truncate(fileContent, 10000),
      filename,
    });
    const res = await callChat(
      [
        { role: 'system', content: `You are a precise code fixer. Generate minimal fixes using GitHub suggestion blocks. Answer in ${config.language === 'vi' ? 'Vietnamese' : 'English'}.` },
        { role: 'user', content: userMsg },
      ],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.2 }
    );
    const cleaned = cleanFinding({ title: '', body: res.content, raw: res.content }, fileContent, true);
    await gh.replyToReviewComment(owner, repo, prNumber, comment.in_reply_to_id || comment.id, cleaned?.body.trim() || 'No applicable code change was generated.');
  } else if (cmd.type === 'chat') {
    const pr = event.pull_request;
    const safeCtx = buildSafeContext(pr);
    const userMsg = interactivePrompt({
      question: cmd.args,
      prTitle: sanitize(safeCtx.title),
      prDescription: sanitize(safeCtx.body),
      fileContext: comment.diff_hunk || '',
    });
    const res = await callChat(
      [
        { role: 'system', content: `You are a helpful code reviewer assistant. Answer in ${config.language === 'vi' ? 'Vietnamese' : 'English'}.` },
        { role: 'user', content: userMsg },
      ],
      { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, temperature: 0.5 }
    );
    await gh.replyToReviewComment(owner, repo, prNumber, comment.in_reply_to_id || comment.id, res.content);
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

    await gh.replyToReviewComment(owner, repo, prNumber, comment.in_reply_to_id || comment.id,
      learningConfirmationMessage(rule, context));
  } catch (err) {
    console.log(`Learning detection failed: ${err.message}`);
  }
}

async function loadConventions(owner, repo, ref, config) {
  return readConventions(gh, owner, repo, ref, config);
}

// Imports remain safe even when a caller has a GitHub event environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function positiveInput(name, fallback) {
  const value = Number(getInput(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
