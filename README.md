# 🔍 Finhay AI Review

AI-powered PR review action hỗ trợ bất kỳ OpenAI-compatible API (OpenAI, Anthropic, Google, DeepSeek, Minimax, ...).

## Features

- 🤖 **Auto Review** — Tự động review khi tạo PR mới
- 🔄 **Incremental Review** — Chỉ review code mới khi push thêm commits
- 💬 **Interactive Chat** — Hỏi đáp về code qua `@finhay-review`
- 📋 **PR Summary** — Tóm tắt PR tự động
- 📚 **Learnings** — Ghi nhớ team preferences, review càng dùng càng đúng
- 📏 **Conventions** — Load coding conventions từ repo
- 🎯 **Severity Levels** — Critical → Major → Minor → Nitpick
- 📝 **PR Metadata Auto-fix** — Tự động reformat PR title theo conventional commits và generate description

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
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: |
      github.event_name == 'pull_request' ||
      contains(github.event.comment.body, '@finhay-review')
    steps:
      - uses: actions/checkout@v4

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
| `@finhay-review resolve` | Resolve tất cả comments |
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

Bot học từ feedback của reviewer. Khi reply sửa review comment → bot hỏi có muốn lưu learning không.

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

Bot tự động cải thiện PR title và description trong mỗi review:

- **Title** — Reformat theo [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`)
  - Branch names (`feature/xyz`) → rewrite dựa trên diff
  - Descriptive nhưng sai format (`Add JWT validation`) → `feat(auth): add JWT validation`
  - Fix typos
- **Description** — Generate nếu trống, cải thiện nếu thiếu cấu trúc (giữ nguyên thông tin gốc)
- Review comment giải thích những gì đã thay đổi

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
                                 └── Ask to save
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

## Cost Estimate

| Model | Cost/review | 50 PRs/tuần |
|-------|------------|-------------|
| DeepSeek Chat | ~$0.001-0.005 | ~$0.05-0.25 |
| Gemini 2.5 Flash | ~$0.002-0.01 | ~$0.10-0.50 |
| GPT-4o mini | ~$0.005-0.01 | ~$0.25-0.50 |
| GPT-4o | ~$0.02-0.05 | ~$1-2.50 |
| Claude Sonnet | ~$0.03-0.10 | ~$1.50-5.00 |

## FAQ

**Q: Bot review PR quá lớn?**
A: Nếu diff > `max_diff_lines` (default 10K), bot skip + comment hướng dẫn review thủ công.

**Q: Muốn tắt auto review cho 1 PR?**
A: Comment `@finhay-review pause` trên PR đó.

**Q: Bot review sai?**
A: Reply sửa → bot sẽ hỏi có muốn lưu learning. Learning giúp review chính xác hơn lần sau.

**Q: Chạy trên fork PRs?**
A: Dùng `pull_request_target` thay `pull_request` nhưng cẩn thận với permissions.

## License

MIT
