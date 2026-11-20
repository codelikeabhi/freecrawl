#!/usr/bin/env bash
# Stealth benchmark (PLAN.md Phase 6, D3): each URL once with Playwright
# (proxy basic, no escalation) and once with the stealth engine (proxy stealth).
# One request at a time. Re-run after every stealth change.
#
#   scripts/fork/benchmark.sh [urls-file]     (default: the public mix below)
#
# OK = 2xx, not flagged blocked (the classifier catches walls), >= 50 characters
# of markdown (nowsecure.nl's pass page is 74). The engine that goes first
# alternates per URL, so a site reacting to a second visit hits both equally.
set -uo pipefail
API="${FIRECRAWL_API_URL:-http://localhost:3002}"
OUT="${OUT:-$(mktemp -d -t benchmark)}"

# D3 (2026-11-21): owner chose a suggested public mix. Home pages only.
DEFAULT_URLS="
easy https://en.wikipedia.org/wiki/Web_scraping
easy https://docs.python.org/3/library/asyncio.html
easy https://www.bbc.com/news
easy https://github.com/firecrawl/firecrawl
easy https://news.ycombinator.com/
protected https://nowsecure.nl
protected https://www.crunchbase.com/
protected https://www.g2.com/
protected https://www.zillow.com/
protected https://www.indeed.com/
protected https://www.glassdoor.com/
protected https://www.etsy.com/
protected https://www.tripadvisor.com/
protected https://www.walmart.com/
protected https://www.nike.com/
protected https://www.reddit.com/r/webscraping/
"
URLS=$([[ -n ${1:-} ]] && cat "$1" || echo "$DEFAULT_URLS")

run() { # url proxy -> "result|status|reason|md|seconds"
  local f t
  f="$OUT/$(echo "$1$2" | shasum | cut -c1-12).json"
  t=$(curl -sS --max-time 150 -o "$f" -w '%{time_total}' -X POST "$API/v2/scrape" \
    -H 'Content-Type: application/json' -d "{\"url\":\"$1\",\"proxy\":\"$2\",\"timeout\":120000}")
  jq -r --arg t "$t" '
    (.data.metadata.statusCode // 0) as $s | (.data.markdown // "" | length) as $m |
    (if .success and $s >= 200 and $s < 300 and (.data.metadata.blocked | not) and $m >= 50
     then "OK" else "FAIL" end) + "|\($s)|\(.data.metadata.blockedReason // (.error // "" | .[0:40]))|\($m)|\($t | tonumber | floor)"
  ' "$f" 2>/dev/null || echo "FAIL|0|no response||$t"
}

printf '| Kind | URL | Playwright | Stealth |\n|---|---|---|---|\n'
pw_ok=0 st_ok=0 total=0
while read -r kind url; do
  [[ -z ${url:-} ]] && continue
  total=$((total + 1))
  if ((total % 2)); then p=$(run "$url" basic); s=$(run "$url" stealth)
  else s=$(run "$url" stealth); p=$(run "$url" basic); fi
  [[ $p == OK* ]] && pw_ok=$((pw_ok + 1))
  [[ $s == OK* ]] && st_ok=$((st_ok + 1))
  fmt() { IFS='|' read -r r st why md sec <<<"$1"; echo "$r $st${why:+ ($why)}, ${md} chars, ${sec}s"; }
  printf '| %s | %s | %s | %s |\n' "$kind" "$url" "$(fmt "$p")" "$(fmt "$s")"
done <<<"$URLS"
printf '\nPlaywright OK: %s/%s, stealth OK: %s/%s\n' "$pw_ok" "$total" "$st_ok" "$total"

# Public fingerprint test page: count the checks it marks as failed.
for proxy in basic stealth; do
  n=$(curl -sS --max-time 150 -X POST "$API/v2/scrape" -H 'Content-Type: application/json' \
    -d "{\"url\":\"https://bot.sannysoft.com/\",\"proxy\":\"$proxy\",\"formats\":[\"rawHtml\"],\"waitFor\":3000}" |
    jq -r '.data.rawHtml // "" | [scan("class=\"failed")] | length')
  printf 'bot.sannysoft.com failed checks (%s): %s\n' "$proxy" "$n"
done
echo "raw responses: $OUT"
