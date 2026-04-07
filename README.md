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

## Quick Start (2 phút)

### 1. Tạo secret

Thêm API key vào repo secrets (ví dụ `LLM_API_KEY`):
**Settings → Secrets and variables → Actions → New repository secret**

### 2. Tạo workflow

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
    if: |
      github.event_name == 'pull_request' ||
      contains(github.event.comment.body, '@finhay-review')
    steps:
      - uses: actions/checkout@v4
      - uses: finhay/finhay-ai-review@v1
        with:
          model: gpt-4o                          # or any OpenAI-compatible model
          api_base: https://api.openai.com/v1    # any OpenAI-compatible endpoint
          api_key: ${{ secrets.LLM_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
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

| Input | Default | Mô tả |
|-------|---------|--------|
| `model` | `MiniMax-M2.7` | Tên model LLM (e.g. `gpt-4o`, `deepseek-chat`) |
| `api_base` | `https://api.minimaxi.chat/v1` | OpenAI-compatible API endpoint |
| `api_key` | (required) | API key |
| `trigger_word` | `@finhay-review` | Keyword trigger |
| `auto_review` | `true` | Auto review on PR open |
| `max_diff_lines` | `10000` | Skip nếu diff lớn hơn |
| `language` | `vi` | Ngôn ngữ review (vi/en) |
| `review_level` | `standard` | Mức độ: relaxed/standard/strict |
| `include_nitpicks` | `false` | Bao gồm nitpick comments |
| `conventions_file` | `.github/review-conventions.md` | File coding conventions |

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

## Architecture

```
GitHub Event
    │
    ├── PR opened/push ──→ Auto/Incremental Review
    │                       ├── Load conventions + learnings
    │                       ├── Chunk diff by file (if large)
    │                       ├── Call LLM API
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
