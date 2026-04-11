// Prompt templates for AI review

export function systemPrompt({ language, reviewLevel, conventions, learnings, includeNitpicks }) {
  const lang = language === 'vi' ? 'Vietnamese' : 'English';
  const strictness = {
    relaxed: 'Focus only on critical bugs and security issues. Ignore style and minor issues.',
    standard: 'Review for bugs, security, performance, and code quality. Balance thoroughness with noise reduction.',
    strict: 'Thorough review covering bugs, security, performance, code quality, naming, and patterns. Be detailed.',
  }[reviewLevel] || 'standard';

  let prompt = `You are a senior code reviewer for a fintech company (securities trading, bonds, savings products).
Your reviews are in ${lang}.

## Review Guidelines
- ${strictness}
- Be specific: reference exact file:line numbers
- Suggest fixes using GitHub suggestion blocks when possible
- Focus on what matters: bugs > security > performance > readability
- Give positive feedback for good patterns (brief)
- Never nitpick formatting if there's a linter/formatter configured${includeNitpicks ? '\n- Include nitpick-level style suggestions' : '\n- Skip nitpick-level style/formatting issues'}
- If you are not certain about a finding, say so — prefix with "Possible issue:" or "Worth checking:"

## Do NOT
- Flag issues that a linter, formatter, or type checker would already catch
- Suggest adding error handling where the framework or caller already guarantees safety
- Hallucinate line numbers — if you cannot determine the exact line, quote the code instead
- Suggest changes that would break existing tests or APIs without mentioning the impact
- Repeat the same finding for multiple occurrences — mention it once and note "same pattern in X other places"
- Add generic advice ("consider adding tests", "add logging") unless there is a specific risk

## Severity Levels
- 🔴 Critical: Bugs that cause crashes, data loss, security vulnerabilities, race conditions
- 🟠 Major: Performance issues, logic errors, missing error handling, bad patterns
- 🟡 Minor: Code quality, maintainability, naming improvements
${includeNitpicks ? '- 🔵 Nitpick: Style, formatting, minor preferences' : ''}

## GitHub Suggestion Block Syntax
When suggesting a code fix, use this exact format:
\`\`\`suggestion
const result = await fetchData();
\`\`\`

## PR Title & Description Review (REQUIRED)
You MUST review the PR title and description in every review. Check for:
- Title is vague, too generic, or doesn't describe the actual change (e.g., "fix bug", "update", "wip", branch names like "feature/xyz")
- Title has typos or grammatical errors
- Title doesn't follow conventional commits or team naming convention (if specified in conventions)
- Description is missing or empty when the PR has non-trivial changes
- Description doesn't explain WHY the change was made (only WHAT)
- Description is missing test plan, migration steps, or breaking change notes when applicable

If the title and description are adequate, write "✅ PR title and description look good." in the PR Metadata section. Do NOT skip this section.

## Output Format
Use this exact structure:

### Tóm tắt
[2-3 sentences summarizing what the PR does and its impact]

### PR Metadata
[ALWAYS include this section. Flag issues with title/description, or confirm they are adequate. Suggest a better title if needed.]

### Findings
[List findings grouped by severity, each with file:line reference]

### ✅ Điểm tốt
[Brief positive feedback, 1-3 bullet points]

If no issues found, say so clearly and still provide the summary and positive feedback.

## Example Finding
🟠 **Major — Missing null check** — \`src/order/service.ts:42\`

\`getOrder()\` can return \`null\` when the order is cancelled, but the caller dereferences without checking:
\`\`\`suggestion
const order = await getOrder(id);
if (!order) throw new OrderNotFoundError(id);
\`\`\``;

  if (conventions) {
    prompt += `\n\n## Team Conventions\n${conventions}`;
  }

  if (learnings && learnings.length > 0) {
    prompt += '\n\n## Team Learnings (from past reviews)\n';
    for (const l of learnings) {
      prompt += `- ${l.rule}${l.context ? ` (applies to: ${l.context})` : ''}\n`;
    }
  }

  return prompt;
}

export function reviewPrompt({ prTitle, prDescription, diff, isIncremental, fileManifest }) {
  const mode = isIncremental
    ? 'This is an INCREMENTAL review — only review the NEW changes below. Do not repeat findings from previous reviews.'
    : 'This is a FULL review of the entire PR.';

  let prompt = `## PR: ${prTitle}

${prDescription ? `### Description\n${prDescription}\n` : ''}
${mode}`;

  if (fileManifest) {
    prompt += `\n\n### Changed Files\n${fileManifest}\n`;
  }

  prompt += `
### Code Changes
\`\`\`diff
${diff}
\`\`\`

Review the changes above and provide your analysis.`;

  return prompt;
}

export function interactivePrompt({ question, prTitle, prDescription, diff, fileContext }) {
  let prompt = `## Context: PR "${prTitle}"
${prDescription ? `Description: ${prDescription}\n` : ''}`;

  if (fileContext) {
    prompt += `\n### Relevant Code\n\`\`\`\n${fileContext}\n\`\`\`\n`;
  } else if (diff) {
    prompt += `\n### PR Diff\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`\n`;
  }

  prompt += `\n### Question\n${question}\n\nAnswer the question based on the code context above. Be specific and helpful.`;
  return prompt;
}

export function summaryPrompt({ prTitle, prDescription, files, diff }) {
  const fileList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  let prompt = `## PR: ${prTitle}
${prDescription ? `Description: ${prDescription}\n` : ''}
### Changed Files
${fileList}`;

  if (diff) {
    prompt += `\n\n### Code Changes (truncated)\n\`\`\`diff\n${diff}\n\`\`\``;
  }

  prompt += `

Write a concise PR summary (3-5 sentences) in Vietnamese. Cover:
1. What changed and why
2. Key areas impacted
3. Any risks or things to watch out for

Output only the summary text, no headers.`;
  return prompt;
}

export function learningDetectionPrompt({ botComment, userReply, codeContext }) {
  let prompt = `A reviewer corrected an AI code review comment.

AI review comment: "${botComment}"
Reviewer replied: "${userReply}"`;

  if (codeContext) {
    prompt += `\n\nCode context:\n\`\`\`\n${codeContext}\n\`\`\``;
  }

  prompt += `

Is the reviewer teaching a general team preference that should apply to future reviews?
If yes, extract the learning as a single concise rule statement.
If no (it's a one-off correction specific to this PR), say "NO_LEARNING".

Output format:
LEARNING: [rule text]
CONTEXT: [file glob pattern if applicable, or "all"]

Or:
NO_LEARNING`;

  return prompt;
}

export function formatReviewBody(content, sha, model) {
  const meta = JSON.stringify({ sha, model, ts: new Date().toISOString() });
  return `<!-- finhay-review-meta: ${meta} -->\n\n## 🔍 AI Code Review\n\n${content}`;
}

export function fixPrompt({ finding, fileContent, filename }) {
  let prompt = `A code review found this issue:

${finding}`;

  if (fileContent) {
    prompt += `\n\nHere is the full file \`${filename}\`:\n\`\`\`\n${fileContent}\n\`\`\``;
  }

  prompt += `\n\nGenerate a fix for this issue. Output ONLY GitHub suggestion block(s) with the corrected code:
\`\`\`suggestion
<corrected code here>
\`\`\`

If the fix requires changes in multiple places, provide each suggestion separately with a brief note.
Keep the fix minimal — only change what's necessary to resolve the issue.`;

  return prompt;
}

export function helpText(triggerWord) {
  return `## 🤖 Finhay Review — Commands

| Command | Description |
|---------|-------------|
| \`${triggerWord}\` [câu hỏi] | Hỏi về code, architecture, logic |
| \`${triggerWord} review\` | Trigger incremental review |
| \`${triggerWord} full review\` | Review lại từ đầu |
| \`${triggerWord} summary\` | Tạo lại tóm tắt PR |
| \`${triggerWord} fix\` | Tạo fix suggestion (reply vào review comment) |
| \`${triggerWord} pause\` | Tạm dừng auto review cho PR này |
| \`${triggerWord} resume\` | Bật lại auto review |
| \`${triggerWord} resolve\` | Resolve tất cả comments cũ |
| \`${triggerWord} help\` | Hiện bảng này |

**Tips:**
- Reply trực tiếp vào review comment để hỏi chi tiết
- Reply \`${triggerWord} fix\` vào finding để bot tạo suggestion fix
- Nếu review sai, reply sửa → bot sẽ hỏi có muốn lưu làm learning không`;
}
