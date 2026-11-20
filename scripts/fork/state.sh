#!/usr/bin/env bash
# Local state (PLAN.md Phase 10): the scrape index in nuq-postgres and the
# document buckets in fake-gcs. Run once after the stack is up, and again
# after the volumes are recreated; it is safe to repeat.
#
#   scripts/fork/state.sh init
set -euo pipefail
cd "$(dirname "$0")/../.."

case "${1:-}" in
  init)
    # shellcheck disable=SC2016
    docker compose exec -T nuq-postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      <fork/state/index.sql 2>/dev/null
    echo "index table and index_get_recent_5: ok"
    for bucket in fc-jobs fc-index; do
      docker compose exec -T api node -e '
        fetch("http://fake-gcs:4443/storage/v1/b?project=local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: process.argv[1] }),
        }).then(r => {
          if (r.status !== 200 && r.status !== 409) { console.error(r.status); process.exit(1); }
          console.log(`bucket ${process.argv[1]}: ok`);
        });' "$bucket" 2>/dev/null
    done
    ;;
  *) echo "usage: $0 init"; exit 2 ;;
esac
