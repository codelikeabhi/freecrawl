---
name: web-fetch-ladder
description: Fetch a web page's content through the local Firecrawl stack, escalating step by step when the page is blocked (bot wall, CAPTCHA, 403), and save it as markdown. Use when asked to read, fetch, scrape or save a specific URL, or when a firecrawl-local scrape came back with metadata.blocked true, a 401/403/429/503 status, or a challenge page.
---

# Web fetch ladder

Climb one rung at a time and stop at the first rung that returns real content. Never use a cloud Firecrawl connector (`mcp__claude_ai_Firecrawl__*`): it spends the owner's paid credits.

## What counts as blocked

A result is blocked when any of these is true:
- `metadata.blocked` is `true` (the API's classifier; `metadata.blockedReason` says why)
- `metadata.statusCode` is 401, 403, 429 or 503
- the markdown is under ~50 characters, or reads like a challenge ("Just a moment...", "verify you are human", "Prove your humanity", "Access denied")
- the tool call errors with "All scraping engines failed"

## Rung 1: local scrape (with automatic stealth)

```
mcp__firecrawl-local__firecrawl_scrape  { "url": "<url>", "formats": ["markdown"], "onlyMainContent": true }
```

The default `proxy: "auto"` already retries a blocked page once on the stealth engine (real Chrome on the host); `metadata.proxyUsed: "stealth"` shows it did. Not blocked: save it (`fetchedVia: firecrawl-local`, or `firecrawl-local-stealth` when `proxyUsed` is `stealth`) and stop.

## Rung 2: forced stealth with time to settle

Only if rung 1 was blocked:

```
mcp__firecrawl-local__firecrawl_scrape  { "url": "<url>", "formats": ["markdown"], "onlyMainContent": true, "proxy": "stealth", "waitFor": 5000 }
```

If this errors with a connection problem, the stealth engine is down: `scripts/fork/stealth.sh status`, then `start`. Not blocked: save (`fetchedVia: firecrawl-local-stealth`) and stop.

## Rung 3: the owner's Chrome (human in the loop)

Only if rung 2 was blocked. Slow and uses Claude usage: a handful of pages, never a crawl. One page at a time.

1. Load the browser tools in one call: `ToolSearch` with `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_close_mcp`. If they do not exist, Chrome integration is off: tell the owner to start Claude Code with `claude --chrome` (or `/chrome`), and stop.
2. `tabs_context_mcp`, then open a **new** tab with `tabs_create_mcp` (never reuse the owner's tabs) and `navigate` to the URL.
3. Check the page (`read_page` or a screenshot). If it shows a CAPTCHA, a "verify you are human" check, a login form or a cookie wall that blocks the content: **stop and ask the owner** to deal with it in that tab, and wait for their reply. Do not type credentials, do not try to solve CAPTCHAs yourself.
4. Once the real page shows, `get_page_text`, and turn the main content into clean markdown (headings, lists, tables, links; drop navigation, footers and ads). Some sites show a blank page for a few seconds while a challenge runs: wait (`computer` action `wait`, 5 s) and look again before deciding it is blocked. `get_page_text` returns only the page's `<article>` when there is one; on a homepage or listing page that can miss most of the content, so also use `read_page` and keep only the text that is on the page. Leave cookie banners alone unless they hide the content (then decline non-essential cookies).
5. Close the tab with `tabs_close_mcp`. Save (`fetchedVia: claude-in-chrome`; `statusCode` is unknown here, leave it out).

Account-free alternative for this rung (no CAPTCHA help from the owner): the Playwright MCP, `claude mcp add playwright -- npx -y @playwright/mcp@latest`.

## Rung 4: give up honestly

Report each rung tried and why it failed (status, `blockedReason`, or what the page showed). Do not save a challenge page as if it were content.

## Saving

Use the helper; it applies the naming and frontmatter rules and prints the path:

```
# rungs 1-2: the scrape result as JSON. Large results are already saved to a
# file by Claude Code ("exceeds maximum allowed tokens ... saved to <path>"):
# pass that path as is, without reading the page into the conversation.
scripts/fork/save-page.py --rungs 1 <result.json>
scripts/fork/save-page.py --rungs 1,2 <result.json>

# rung 3: write the markdown to a scratch file first, then
scripts/fork/save-page.py --url "<url>" --title "<title>" --via claude-in-chrome --rungs 1,2,3 < page.md
```

Path: `crawl-output/<domain>/<path-slug>.md` (git-ignored).
- `<domain>`: hostname without `www.`
- `<path-slug>`: path plus query, lowercased, every run of characters other than `a-z0-9` replaced with `-`, trimmed of `-`, at most 80 characters; `index` for the root page

```markdown
---
url: https://example.com/some/page
title: "Page title"
statusCode: 200            # omit when unknown (Chrome rung)
fetchedVia: firecrawl-local   # firecrawl-local | firecrawl-local-stealth | claude-in-chrome
fetchedAt: 2026-11-21T10:15:00Z   # UTC, ISO 8601
rungsTried: [1]            # e.g. [1, 2, 3]
---

<markdown content>
```

## Rules

- Respect the site's terms and robots.txt; only log in or pass checks the owner approves, in their own tab.
- Screenshots and PDFs from firecrawl-local come back as `http://localhost:3010/...`; read the matching `metadata.localFiles` path instead.
