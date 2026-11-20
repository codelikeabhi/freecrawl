#!/usr/bin/env bash
# Run API snips (E2E tests) against the running compose stack, inside Docker.
#
#   scripts/fork/snips.sh src/__tests__/snips/v2/fork-search.test.ts [more files...]
#
# ponytail: stands in for `pnpm harness pnpm exec vitest run` on hosts without a
# Rust toolchain. The stack must already be up (`docker compose up -d`). Source
# is mounted read-only, so test edits need no rebuild; API code changes still
# need `docker compose up -d --build api` first.
set -euo pipefail
cd "$(dirname "$0")/../.."

docker build -q --target build -t firecrawl-api-build apps/api >/dev/null
docker build -q -t firecrawl-api-test fork/test-runner >/dev/null

# Only what the tests read for gating; .env as a whole would also set PORT,
# which is a bind address here, not a number.
env_from_dotenv() { grep -E "^($1)=" .env 2>/dev/null | sed 's/^/-e /' || true; }

# shellcheck disable=SC2046
docker run --rm --network firecrawl_backend \
  -v "$PWD/apps/api/src:/app/src:ro" \
  -e TEST_API_URL=http://api:3002 \
  -e TEST_SUITE_SELF_HOSTED=true \
  -e USE_DB_AUTHENTICATION=false \
  -e TEST_API_KEY=fc-selfhosted -e TEST_TEAM_ID=bypass \
  -e REDIS_URL=redis://redis:6379 \
  -e REDIS_RATE_LIMIT_URL=redis://redis:6379 \
  -e PLAYWRIGHT_MICROSERVICE_URL=http://playwright-service:3000/scrape \
  $(env_from_dotenv 'SEARXNG_ENDPOINT|OPENAI_API_KEY|OPENAI_BASE_URL|OLLAMA_BASE_URL|MODEL_NAME|FORK_STEALTH_URL|FIRE_PDF_ENABLE|FIRE_PDF_BASE_URL|IMAGE_OCR_ENABLED|PDF_RUST_EXTRACT_ENABLE|PARSE_PDF_ALWAYS_FIRE_PDF') \
  firecrawl-api-test pnpm exec vitest run "$@"
