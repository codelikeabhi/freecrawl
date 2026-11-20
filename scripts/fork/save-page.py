#!/usr/bin/env python3
"""Save a fetched page as crawl-output/<domain>/<path-slug>.md with YAML
frontmatter (web-fetch-ladder skill, PLAN.md Phase 7). Standard library only.

  # rungs 1-2: a firecrawl-local scrape result (JSON with markdown + metadata)
  scripts/fork/save-page.py --rungs 1 result.json

  # rung 3: markdown made from the Chrome page, on stdin
  scripts/fork/save-page.py --url URL --title TITLE --via claude-in-chrome --rungs 1,2,3 < page.md

Prints the path it wrote.
"""
import argparse
import datetime
import json
import pathlib
import re
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2] / "crawl-output"


def target(url: str) -> pathlib.Path:
    parts = urllib.parse.urlsplit(url)
    domain = (parts.hostname or "unknown").removeprefix("www.")
    raw = parts.path + ("?" + parts.query if parts.query else "")
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")[:80] or "index"
    return ROOT / domain / f"{slug}.md"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("json_file", nargs="?", help="firecrawl-local scrape result")
    ap.add_argument("--url")
    ap.add_argument("--title", default="")
    ap.add_argument("--via", help="firecrawl-local | firecrawl-local-stealth | claude-in-chrome")
    ap.add_argument("--rungs", default="1", help="comma list, e.g. 1,2,3")
    a = ap.parse_args()

    status = None
    if a.json_file:
        doc = json.loads(pathlib.Path(a.json_file).read_text())
        doc = doc.get("data", doc)  # raw API response or the MCP tool's result
        meta = doc.get("metadata", {})
        url = meta.get("url") or meta.get("sourceURL") or a.url
        title = meta.get("title") or a.title
        status = meta.get("statusCode")
        markdown = doc.get("markdown", "")
        via = a.via or ("firecrawl-local-stealth" if meta.get("proxyUsed") == "stealth" else "firecrawl-local")
    else:
        url, title, markdown, via = a.url, a.title, sys.stdin.read(), a.via or "claude-in-chrome"
    if not url:
        sys.exit("need a scrape result file or --url")

    lines = ["---", f"url: {url}", f"title: {json.dumps(title, ensure_ascii=False)}"]
    if status is not None:
        lines.append(f"statusCode: {status}")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rungs = ", ".join(r.strip() for r in a.rungs.split(",") if r.strip())
    lines += [f"fetchedVia: {via}", f"fetchedAt: {now}", f"rungsTried: [{rungs}]", "---", "", ""]

    out = target(url)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + markdown.strip() + "\n")
    print(out)


if __name__ == "__main__":
    main()
