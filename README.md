# 🔍 Finhay AI Review

AI-powered PR review action hỗ trợ bất kỳ OpenAI-compatible API (OpenAI, Anthropic, Google, DeepSeek, Minimax, ...).

## Features

- 🤖 **Auto Review** — Tự động review khi tạo PR mới
- 🔄 **Incremental Review** — Chỉ review code mới khi push thêm commits
- 💬 **Interactive Chat** — Hỏi đáp về code qua `@finhay-review`
- 📋 **PR Summary** — Tóm tắt PR tự động
- 📚 **Learnings** — Ghi nhớ team preferences, load team rules từ repo; đề xuất learning từ feedback
- 📏 **Conventions** — Load coding conventions từ repo
- 🎯 **Severity Levels** — Critical → Major → Minor → Nitpick
- 📝 **PR Metadata Auto-fix** — Opt-in reformat PR title theo conventional commits và generate description

## Quick Start (2 phút)

### Option A: Organization-wide setup (khuyến nghị)

Cấu hình 1 lần cho toàn bộ org, mọi repo dùng chung.

#### 1. Tạo org variables & secrets

Vào **Organization Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|------|------|-------|
| Variable | `AI_REVIEW_MODEL` | `MiniMax-M2.7` (hoặc `gpt-4o`, `deepseek-chat`, ...) |
| Variable | `AI_REVIEW_API_BASE` | `https://api.minimaxi.chat/v1` (hoặc endpoint tương ứng) |
| Secret | `AI_REVIEW_API_KEY` | API key của provider |

#### 2. (Tuỳ chọn) Custom bot name & avatar với GitHub App

Mặc định review hiển thị là `github-actions[bot]`. Muốn custom tên và avatar:

1. Tạo **GitHub App** trong org: **Settings → Developer settings → GitHub Apps → New**
   - Đặt tên (vd: "Finhay AI Reviewer"), upload avatar
   - Permissions: `Pull requests: Read & Write`, `Contents: Read`, `Issues: Read & Write`
2. Install app vào org
3. Thêm vào org variables & secrets:

| Type | Name | Value |
|------|------|-------|
| Variable | `AI_REVIEW_APP_ID` | App ID (từ trang settings của app) |
| Secret | `AI_REVIEW_APP_PRIVATE_KEY` | Private key (generate từ trang settings) |

#### 3. Tạo workflow trong mỗi repo

```yaml
# .github/workflows/ai-review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  # Pushes to the same PR supersede each other, but every comment gets its own
  # group: concurrency is evaluated before the job `if`, so a comment run that
  # ends up skipped would still cancel a review that is mid-flight.
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number }}-${{ github.event.comment.id || 'push' }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    if: |
      github.event_name == 'pull_request' || github.event_name == 'pull_request_target' || (
        github.event.comment.user.type != 'Bot' &&
        (contains(github.event.comment.body, '@finhay-review') ||
         (github.event_name == 'pull_request_review_comment' && github.event.comment.in_reply_to_id))
      )
    steps:
      # Nếu dùng GitHub App (custom bot name/avatar):
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ vars.AI_REVIEW_APP_ID }}
          private-key: ${{ secrets.AI_REVIEW_APP_PRIVATE_KEY }}

      - uses: finhay/finhay-ai-review@v1
        with:
          model: ${{ vars.AI_REVIEW_MODEL }}
          api_base: ${{ vars.AI_REVIEW_API_BASE }}
          api_key: ${{ secrets.AI_REVIEW_API_KEY }}
          github_token: ${{ steps.app-token.outputs.token }}
```

> **Không dùng GitHub App?** Bỏ step `create-github-app-token` và xoá dòng `github_token` — action sẽ dùng `GITHUB_TOKEN` mặc định (hiển thị là `github-actions[bot]`).

Muốn đổi model? Chỉ cần update org variable — tất cả repos tự apply.

### Option B: Per-repo setup

```yaml
      - uses: finhay/finhay-ai-review@v1
        with:
          model: gpt-4o
          api_base: https://api.openai.com/v1
          api_key: ${{ secrets.LLM_API_KEY }}
```

### 3. Done! 🎉

Tạo PR mới → bot tự review.

## Commands

Comment `@finhay-review` + command trong PR:

| Command | Mô tả |
|---------|--------|
| `@finhay-review` [câu hỏi] | Hỏi về code, architecture, logic |
| `@finhay-review review` | Trigger incremental review |
| `@finhay-review full review` | Review lại từ đầu |
| `@finhay-review summary` | Tạo tóm tắt PR |
| `@finhay-review pause` | Tạm dừng auto review |
| `@finhay-review resume` | Bật lại auto review |
| `@finhay-review resolve` | Chưa hỗ trợ; resolve threads trực tiếp trên GitHub |
| `@finhay-review help` | Hiện help |

## Configuration

### Action Inputs

| Input | Default | Org var/secret | Mô tả |
|-------|---------|----------------|--------|
| `model` | `MiniMax-M2.7` | `AI_REVIEW_MODEL` | Tên model LLM |
| `api_base` | `https://api.minimaxi.chat/v1` | `AI_REVIEW_API_BASE` | OpenAI-compatible API endpoint |
| `api_key` | (required) | `AI_REVIEW_API_KEY` | API key |
| `github_token` | `${{ github.token }}` | `AI_REVIEW_APP_ID` + `AI_REVIEW_APP_PRIVATE_KEY` | GitHub token (dùng App token để custom bot name/avatar) |
| `trigger_word` | `@finhay-review` | — | Keyword trigger |
| `auto_review` | `true` | — | Auto review on PR open |
| `max_diff_lines` | `10000` | — | Skip nếu diff lớn hơn |
| `language` | `vi` | — | Ngôn ngữ review (vi/en) |
| `review_level` | `standard` | — | Mức độ: relaxed/standard/strict |
| `include_nitpicks` | `false` | — | Bao gồm nitpick comments |
| `conventions_file` | `.github/review-conventions.md` | — | File coding conventions |
| `review_budget_minutes` | `10` | — | Tổng ngân sách LLM gồm review, verification và summary. Hết giờ post coverage còn thiếu; giữ nhỏ hơn job timeout |
| `verify_findings` | `true` | — | Kiểm chứng findings với source tại reviewed SHA; tăng số request LLM |
| `auto_fix_metadata` | `false` | — | Cho phép sửa title/description sau initial review hoàn chỉnh |

### Conventions File

Tạo `.github/review-conventions.md` trong repo:

```markdown
# Review Conventions

## General
- Use BigDecimal for monetary calculations
- Handle errors explicitly

## Security
- Never log PII
- Validate all inputs
```

Bot tự detect thêm: `CLAUDE.md`, `.cursorrules`, `CONVENTIONS.md`, `.github/copilot-instructions.md`

### Learnings System

Bot đọc rules đã được merge vào base branch. Khi reply sửa review comment, bot có thể đề xuất một rule. Maintainer thêm rule vào `.github/review-learnings.json` qua PR; bot chưa tự lưu hoặc tạo PR khi reply `yes`. Workflow cần nhận các inline replies không có trigger word (như example ở trên).

Learnings lưu tại `.github/review-learnings.json`:

```json
[
  {
    "rule": "Prefer early returns over nested try-catch in auth services",
    "context": "src/auth/*",
    "added_by": "tuan.tran",
    "date": "2026-04-06"
  }
]
```

Learnings hỗ trợ path-based matching — rule chỉ apply cho files match glob pattern.

### PR Metadata Auto-fix

Mặc định **không sửa** metadata. Bật `auto_fix_metadata: true` để cải thiện title/description sau initial review hoàn chỉnh:

- **Title** — Reformat theo [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`)
  - Branch names (`feature/xyz`) → rewrite dựa trên diff
  - Descriptive nhưng sai format (`Add JWT validation`) → `feat(auth): add JWT validation`
  - Fix typos
- **Description** — Generate nếu trống, cải thiện nếu thiếu cấu trúc (giữ nguyên thông tin gốc)
- Trước khi sửa, bot kiểm tra PR còn mở, SHA không đổi và title/body vẫn giống lúc bắt đầu. GitHub không có atomic compare-and-set cho metadata, nên opt-in này vẫn có một khoảng race nhỏ; giữ tắt nếu cần bảo toàn tuyệt đối mọi edit đồng thời.

## Architecture

```
GitHub Event
    │
    ├── PR opened/push ──→ Auto/Incremental Review
    │                       ├── Load conventions + learnings
    │                       ├── Chunk diff by file (if large)
    │                       ├── Call LLM API
    │                       ├── Auto-fix PR title & description
    │                       └── Post PR Review (with severity)
    │
    ├── Comment @finhay-review ──→ Command Parser
    │                           ├── review/full review → trigger review
    │                           ├── pause/resume → toggle auto review
    │                           ├── summary → generate PR summary
    │                           ├── help → show commands
    │                           └── [text] → chat/Q&A
    │
    └── Review comment reply ──→ Learning Detection
                                 ├── Is this a correction?
                                 ├── Extract learning rule
                                 └── Suggest a rule for manual PR
```

## Supported Providers

Bất kỳ provider nào hỗ trợ OpenAI-compatible API:

| Provider | `api_base` | `model` (ví dụ) |
|----------|-----------|-----------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o`, `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| Google | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Minimax | `https://api.minimaxi.chat/v1` | `MiniMax-M2.7` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |

```yaml
# Ví dụ: DeepSeek
- uses: finhay/finhay-ai-review@v1
  with:
    model: deepseek-chat
    api_base: https://api.deepseek.com
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}

# Ví dụ: Google Gemini
- uses: finhay/finhay-ai-review@v1
  with:
    model: gemini-2.5-flash
    api_base: https://generativelanguage.googleapis.com/v1beta/openai
    api_key: ${{ secrets.GOOGLE_API_KEY }}
```

## Cost measurement

Verification adds a model request for each candidate that passes the deterministic
filters. Historical per-review estimates without verification are not applicable.
Use `reviewMetrics` logs to measure returned prompt/completion tokens, calls and
latency on representative PRs, then apply your provider's current pricing. Returned usage is accumulated across retries, including rejected empty or truncated
responses. Requests that time out or fail without usage may still incur unreported cost.

## FAQ

**Q: Bot review PR quá lớn?**
A: Nếu diff > `max_diff_lines` (default 10K), bot skip + comment hướng dẫn review thủ công.

**Q: Muốn tắt auto review cho 1 PR?**
A: Comment `@finhay-review pause` trên PR đó.

**Q: Bot review sai?**
A: Reply sửa → bot có thể đề xuất rule. Thêm rule qua PR vào review-learnings.json; không có auto-save.

**Q: Chạy trên fork PRs?**
A: Action xử lý `pull_request_target` qua API, không cần checkout code PR. Nếu dùng event này, không thêm bước checkout/run code từ fork với token/secrets của base repo.

## License

MIT

## Reliability and review coverage

Reviews record the base SHA, reviewed SHA, comparison base and completed batch IDs.
A SHA alone from an older action version is not considered proof of complete coverage;
the first run after upgrading may do a full review.

- Diffs are split at file/hunk lines and packed without truncating reviewed code. A single oversized line remains unreviewed and is reported explicitly.
- Incomplete reviews publish their resumable coverage and then fail the Actions job, including manually triggered reviews. A green review check therefore no longer hides partial model failures.
- `review` resumes unfinished batches on the same snapshot. A new head reviews from the last complete checkpoint, or from the PR base when no trustworthy checkpoint exists. `full review` deliberately starts over.
- Merge commits are reviewed. Force-pushes and base changes fall back to full review when the previous checkpoint is no longer applicable.
- Both review output and optional source context use immutable SHAs. The bot checks that the PR is open and unchanged before posting; reviews carry `commit_id` in case a push races with posting.
- Candidates with missing, malformed or out-of-batch locations are retained under “Cần verify” as explicitly unverified items, never posted inline. They do not discard valid findings in the same batch; complete coverage can still include items requiring human review.
- Verification reads at most four bounded source excerpts per candidate, using imports and filename matches. This is heuristic context retrieval, not a complete call graph. Unsupported candidates are dropped or moved to “Cần verify”; verifier failures leave the batch incomplete.
- Review completeness means all eligible diff batches were processed successfully, not that every bug was found. Generated/binary exclusions still apply. Duplicate findings within a run are collapsed, and incremental prompts include previous review context.
- Structured `reviewMetrics` logs report logical model calls, failed calls, returned token usage across attempts, verification outcomes and elapsed time. Token counts include rejected responses when usage is returned; they are not a billing total.
- Conventions and learnings come from the trusted base revision. Model-generated PR metadata is disabled by default.

Existing consumers must copy the updated workflow conditions and concurrency group;
upgrading the action reference alone does not update workflows in other repositories.
An example is available in [examples/consumer-workflow.yml](examples/consumer-workflow.yml).

## Development and evaluation

```sh
npm test
npm run eval
```

`npm test` includes mocked event orchestration, HTTP failure handling, snapshot consistency,
partial-review recovery and finding validation. `npm run eval` checks deterministic filters
on minimized reproductions of historical PR findings. It makes no model requests and does
not measure model accuracy. See [evals/README.md](evals/README.md) for live replay.

### DeepSeek V4 request handling

For `deepseek-v4-pro` and `deepseek-v4-flash` (including suffixed versions), the
client explicitly enables thinking with `reasoning_effort: low`, reserves at least
32,768 output tokens for reasoning and the answer, and allows up to four minutes
per attempt. The total review budget still bounds every attempt. Other models keep
the existing token limits and two-minute request timeout.

A V4 response ending with `length` can retry with a doubled token limit, capped at
65,536. Empty final answers retry within the existing three-attempt limit and total
budget. Truncated answers are never accepted as completed reviews. These limits can
increase token consumption; returned usage from all attempts is included in metrics.
Failure diagnostics include the finish reason, reasoning character count and token
limit without logging the response or reasoning text.
