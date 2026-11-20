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

This checkout is a private self-hosted fork. Plan and notes: `PLAN.md`, `docs/fork/` (local only, kept out of git by `.git/info/exclude`; never commit or push them).

- For web scraping, use the `firecrawl-local` MCP server (our API at http://localhost:3002). If a cloud Firecrawl connector from claude.ai is also loaded (tools like `mcp__claude_ai_Firecrawl__*`), do not use it unless the owner asks, because it spends paid credits.
- `firecrawl-local` also lists Cloud-only tools (agent, interact, monitor, research papers). They fail against the local API; do not use them.
- Screenshots and action PDFs come back as `http://localhost:3010/...` URLs, which WebFetch cannot open. Read the matching path in `metadata.localFiles` with the Read tool instead (files are deleted after 24 h).
- The stealth engine runs on the host, not in Docker, started at login by a LaunchAgent (`scripts/fork/stealth.sh status|logs`). Without it, `proxy: "stealth"`, `profile` and blocked-page escalation fail. After editing `apps/playwright-service-ts/api.ts`, run `scripts/fork/stealth.sh install-agent` (the agent runs a copy) and rebuild the `playwright-service` image. A response with `metadata.blocked: true` is a bot wall, not content.
- When a page is blocked, follow the `web-fetch-ladder` skill (`.claude/skills/web-fetch-ladder/`, added in Phase 7 of `PLAN.md`).
- OCR (scanned PDFs, images) runs on the host too: MinerU behind FirePDF's `/ocr` contract on 127.0.0.1:3020, started at login (`scripts/fork/ocr.sh status|logs`). After editing `apps/ocr-service/server.py`, run `scripts/fork/ocr.sh install-agent`. Simple single-column text PDFs stay on the fast Rust path; PDFs with tables or columns go to it for layout (about 1.5 s a page); if it fails, the API falls back to plain text.
- Research, developer and gov search (`/v2/search/research/*`, `/v2/search/developer`, `/v2/search/gov`, and the `developer`/`gov` categories of `/v2/search`) come from our `indexes` container (`apps/index-service`): OpenAlex, arXiv, UniProt, GitHub, Stack Overflow, eCFR, Federal Register and SearXNG, cached in Redis. Results differ from Firecrawl Cloud's own indexes. After editing it, `docker compose up -d --build indexes`.
- Cache (`maxAge`, `lockdown`), `GET /v2/scrape/:id` and change tracking use local state: the scrape index in nuq-postgres, documents in the `fake-gcs` container (`FORK_GCS_ENDPOINT`), job access/state and change history in Redis (`FORK_LOCAL_STATE`, `lib/fork-state.ts`). After recreating volumes, run `scripts/fork/state.sh init`. Cached copies of a page are kept until you delete the volumes.
- Monitors (`/v2/monitor`) run with auth off: tables in nuq-postgres (`fork/state/monitor.sql`), scheduler in the queue-worker, checks once a minute. Webhooks to a receiver on the Mac use `http://host.docker.internal:<port>/...` (only that host is allowed) and carry `X-Firecrawl-Signature` (HMAC secret `SELF_HOSTED_WEBHOOK_HMAC_SECRET` in `.env`). Delete test monitors when done; they keep running on schedule.
- `audio`, `video` and YouTube metadata/transcripts come from the `media` container (`apps/media-service`, yt-dlp); files land at `http://localhost:3010/...` (Read the matching file in `data/files`). Only for media the owner may download. If YouTube breaks, rebuild it to update yt-dlp: `docker compose up -d --build media`.
- Commits to this public repo use the GitHub no-reply address (repo-local `user.email`); keep work email, home paths and LAN addresses out of commits.