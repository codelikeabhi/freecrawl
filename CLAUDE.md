Firecrawl is a web scraper API. The directory you have access to is a monorepo:
 - `apps/api` has the actual API and worker code
 - `apps/*-sdk` are various SDKs

When making changes to the API, here are the general steps you should take:
1. Write some end-to-end tests that assert your win conditions, if they don't already exist
  - 1 happy path (more is encouraged if there are multiple happy paths with significantly different code paths taken)
  - 1+ failure path(s)
  - Generally, E2E (called `snips` in the API) is always preferred over unit testing.
  - In the API, always use `scrapeTimeout` from `./lib` to set the timeout you use for scrapes.
  - These tests will be ran on a variety of configurations. You should gate tests in the following manner:
    - If it requires fire-engine: `!process.env.TEST_SUITE_SELF_HOSTED`
    - If it requires AI: `!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL`
2. Write code to achieve your win conditions
3. Run your tests using `pnpm harness pnpm exec vitest run ...`
  - `pnpm harness` is a command that gets the API server and workers up for you to run the tests. Don't try to `pnpm start` manually.
  - The full test suite takes a long time to run, so you should try to only execute the relevant tests locally, and let CI run the full test suite.
4. Push to a branch, open a PR, and let CI run to verify your win condition.
Keep these steps in mind while building your TODO list.

Never bypass `knip` failures (e.g. with `git commit --no-verify`). If the pre-commit `knip` check fails, fix the reported unused exports/files — even if they predate your change — before committing.

## Fork rules

This checkout is a private self-hosted fork. Plan and notes: `PLAN.md`, `docs/fork/`.

- For web scraping, use the `firecrawl-local` MCP server (our API at http://localhost:3002). If a cloud Firecrawl connector from claude.ai is also loaded (tools like `mcp__claude_ai_Firecrawl__*`), do not use it unless the owner asks, because it spends paid credits.
- `firecrawl-local` also lists Cloud-only tools (agent, interact, monitor, research papers). They fail against the local API; do not use them.
- Screenshots and action PDFs come back as `http://localhost:3010/...` URLs, which WebFetch cannot open. Read the matching path in `metadata.localFiles` with the Read tool instead (files are deleted after 24 h).
- When a page is blocked, follow the `web-fetch-ladder` skill (`.claude/skills/web-fetch-ladder/`, added in Phase 7 of `PLAN.md`).