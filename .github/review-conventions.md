# Review Conventions

## General
- Prefer immutability where possible
- Use meaningful variable/function names (English)
- Handle errors explicitly, avoid swallowing exceptions
- Log errors with enough context for debugging

## Java/Kotlin (Backend)
- Use BigDecimal for monetary calculations, NEVER float/double
- Always close resources (try-with-resources)
- Check null safety
- Use Optional instead of returning null
- Spring: prefer constructor injection over field injection

## TypeScript/JavaScript
- Use strict TypeScript (no `any` unless justified)
- Prefer `const` over `let`
- Async/await over raw Promises

## SQL
- Always use parameterized queries (prevent SQL injection)
- Index columns used in WHERE/JOIN
- Avoid SELECT *

## Security
- Never log sensitive data (passwords, tokens, PII)
- Validate all user inputs
- Use HTTPS for all external calls
