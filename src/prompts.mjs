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

## Code Quality Litmus Tests
When reviewing, evaluate against these principles:
- **Surgical changes**: Does every changed line trace directly to the PR's stated purpose? Flag unrelated refactoring, drive-by style changes, or reformatting of adjacent code mixed in with logic changes.
- **Simplicity first**: Would a senior engineer say this is overcomplicated? Flag over-abstraction (e.g., strategy patterns for single-use cases), speculative features, unnecessary configurability, or excessive error handling for impossible scenarios. If 200 lines could be 50, say so.
- **Test coverage**: Does the PR include tests for new features or bug fixes? A feature without tests or a bug fix without a reproducing test is incomplete.

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

## PR Title & Description Auto-fix (REQUIRED)
You MUST review AND fix the PR title and description in every review.

### Title rules:
- MUST follow conventional commits format: \`type(scope): subject\`
- Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
- Subject: lowercase, imperative mood, max 50 chars, no period
- If the current title is a branch name (e.g., "feature/xyz", "fix/abc", "hotfix-something"), rewrite it entirely based on the diff
- If the current title is descriptive but not conventional commits format, reformat it (e.g., "Add JWT validation" → "feat(auth): add JWT validation")
- Fix any typos

### Description rules:
- If empty: generate a structured description based on the diff
- If exists but poorly structured: improve it while preserving ALL original information
- Structure: Summary (what & why), Key Changes (bullet points), and any relevant notes (breaking changes, migration steps, etc.)

### Output format for auto-fix:
At the END of your review, output a JSON block with the improved title and description. Use this exact format:

\`\`\`pr-metadata
{"title": "feat(scope): improved title here", "description": "## Summary\\n...\\n\\n## Key Changes\\n- ..."}
\`\`\`

Rules for the JSON block:
- Set "title" to null if the current title already follows conventional commits format perfectly
- Set "description" to null if the current description is already well-structured and complete
- The description should be in the same language as the review (Vietnamese or English as configured)
- Always use \\n for newlines in the JSON string

## Output Format
Use this exact structure:

### Tóm tắt
[2-3 sentences summarizing what the PR does and its impact]

### PR Metadata
[ALWAYS include this section. Explain what was changed and why. If title/description were auto-fixed, show the before → after. If already good, confirm with "✅ PR title and description look good."]

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
    prompt += `\n\n<team_conventions>\n${conventions}\n</team_conventions>`;
  }

  if (learnings && learnings.length > 0) {
    prompt += '\n\n<team_learnings>\n';
    for (const l of learnings) {
      prompt += `- ${l.rule}${l.context ? ` (applies to: ${l.context})` : ''}\n`;
    }
    prompt += '</team_learnings>';
  }

  return prompt;
}

export function reviewPrompt({ prTitle, prDescription, diff, isIncremental, fileManifest }) {
  const mode = isIncremental
    ? 'This is an INCREMENTAL review — only review the NEW changes below. Do not repeat findings from previous reviews.'
    : 'This is a FULL review of the entire PR.';

  let prompt = `<pr_title>${prTitle}</pr_title>\n\n${mode}`;

  if (prDescription) {
    prompt += `\n\n<pr_description>\n${prDescription}\n</pr_description>`;
  }

  if (fileManifest) {
    prompt += `\n\n<changed_files>\n${fileManifest}\n</changed_files>`;
  }

  prompt += `\n\n<code_diff>\n${diff}\n</code_diff>

Review the changes above and provide your analysis.`;

  return prompt;
}

export function interactivePrompt({ question, prTitle, prDescription, diff, fileContext }) {
  let prompt = `<pr_title>${prTitle}</pr_title>`;

  if (prDescription) {
    prompt += `\n\n<pr_description>\n${prDescription}\n</pr_description>`;
  }

  if (fileContext) {
    prompt += `\n\n<code_context>\n${fileContext}\n</code_context>`;
  } else if (diff) {
    prompt += `\n\n<code_diff>\n${diff.slice(0, 8000)}\n</code_diff>`;
  }

  prompt += `\n\n<question>\n${question}\n</question>

Answer the question based on the code context above. Be specific and helpful.`;
  return prompt;
}

export function summaryPrompt({ prTitle, prDescription, files, diff }) {
  const fileList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  let prompt = `<pr_title>${prTitle}</pr_title>`;

  if (prDescription) {
    prompt += `\n\n<pr_description>\n${prDescription}\n</pr_description>`;
  }

  prompt += `\n\n<changed_files>\n${fileList}\n</changed_files>`;

  if (diff) {
    prompt += `\n\n<code_diff>\n${diff}\n</code_diff>`;
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
