#!/usr/bin/env bash
# Smoke test for the local Firecrawl stack (PLAN.md Phase 1).
#
#   scripts/fork/smoke.sh                  run all checks, prints the crawl id at the end
#   CRAWL_ID=<id> scripts/fork/smoke.sh    also check that an earlier crawl is still retrievable
#
# Exit code 0 only if every check passed.
set -uo pipefail

API="${FIRECRAWL_API_URL:-http://localhost:3002}"
# books.toscrape.com is a public practice site built for scrapers, with plenty of links.
SITE="${SMOKE_CRAWL_URL:-https://books.toscrape.com/}"
# Self-hosted map only reads sitemap.xml (no Fire-engine search, no index), so use a site with one.
MAP_SITE="${SMOKE_MAP_URL:-https://docs.firecrawl.dev}"
failed=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n      %s\n' "$1" "${2:0:400}"; failed=1; }

# check NAME JQ_FILTER CURL_ARGS... -> passes when the filter prints "true"
check() {
  local name=$1 filter=$2 body
  shift 2
  if ! body=$(curl -sS --max-time 120 "$@" 2>&1); then fail "$name" "$body"; return 1; fi
  if [[ $(jq -r "$filter" <<<"$body" 2>/dev/null) == true ]]; then pass "$name"; else fail "$name" "$body"; return 1; fi
}

post() { check "$1" "$2" -X POST "$API$3" -H 'Content-Type: application/json' -d "$4"; }

check "readiness" '.status == "ok"' "$API/v0/health/readiness"

post "scrape example.com (markdown)" \
  '.success == true and .data.metadata.statusCode == 200 and (.data.markdown | length) > 0' \
  /v2/scrape '{"url":"https://example.com","formats":["markdown"]}'

post "map $MAP_SITE" '.success == true and (.links | length) > 0' \
  /v2/map "{\"url\":\"$MAP_SITE\",\"limit\":20}"

# Crawl is async: start it, then poll until it leaves "scraping" (max ~3 min).
id=$(curl -sS --max-time 30 -X POST "$API/v2/crawl" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$SITE\",\"limit\":5}" | jq -r '.id // empty' 2>/dev/null)
if [[ -z $id ]]; then
  fail "crawl start" "no crawl id returned"
else
  status="" completed=0 body=""
  for _ in $(seq 1 60); do
    body=$(curl -sS --max-time 30 "$API/v2/crawl/$id")
    status=$(jq -r '.status' <<<"$body" 2>/dev/null)
    [[ $status == scraping ]] || break
    sleep 3
  done
  completed=$(jq -r '.completed // 0' <<<"$body" 2>/dev/null)
  if [[ $status == completed && $completed -ge 5 ]]; then
    pass "crawl 5 pages ($id)"
  else
    fail "crawl 5 pages ($id)" "status=$status completed=$completed"
  fi
fi

if [[ -n ${CRAWL_ID:-} ]]; then
  check "earlier crawl $CRAWL_ID still retrievable" \
    '.status == "completed" and (.data | length) > 0' "$API/v2/crawl/$CRAWL_ID"
fi

[[ -n ${id:-} ]] && echo "crawl id: $id"
exit $failed
