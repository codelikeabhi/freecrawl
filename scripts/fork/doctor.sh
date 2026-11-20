#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok/bad never fail, so A && ok || bad is safe
# Health check for the whole local stack (PLAN.md Phase 16). Run after a
# restart, after the Mac wakes, or when something looks off.
#
#   scripts/fork/doctor.sh          containers, services, host agents, smoke test
#   scripts/fork/doctor.sh --full   also the gap matrix (slow, uses the network)
#
# Exit code 0 only if every check passed.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

failed=0
ok() { printf 'OK    %s\n' "$1"; }
bad() { printf 'FAIL  %s  %s\n' "$1" "${2:-}"; failed=1; }

# 1. Every compose service is running (FoundationDB is opt-in, skip it).
for svc in $(docker compose config --services 2>/dev/null | grep -v foundationdb); do
  state=$(docker compose ps --format '{{.State}}' "$svc" 2>/dev/null)
  [[ $state == running ]] && ok "container $svc" || bad "container $svc" "${state:-not created}"
done

# 2. Services on the Docker network answer (asked from inside the api container).
services=$(docker compose exec -T api node -e '
const checks = {
  searxng: "http://searxng:8080/healthz",
  indexes: "http://indexes:8080/health",
  media: "http://media:8080/health",
  privacy: "http://privacy:8080/health",
  "fake-gcs": "http://fake-gcs:4443/storage/v1/b?project=local",
  playwright: "http://playwright-service:3000/health",
  "ocr (host)": "http://host.docker.internal:3020/health",
  "stealth (host)": "http://host.docker.internal:3003/health",
  "ollama (host)": "http://host.docker.internal:11434/api/tags",
};
Promise.all(Object.entries(checks).map(([name, url]) =>
  fetch(url, { signal: AbortSignal.timeout(10000) })
    .then(r => console.log(`${r.ok ? "OK  " : "FAIL"}  service ${name}${r.ok ? "" : "  HTTP " + r.status}`))
    .catch(e => console.log(`FAIL  service ${name}  ${e.cause?.code ?? e.message}`))));
' 2>/dev/null)
printf '%s\n' "$services"
grep -q '^FAIL' <<<"$services" && failed=1

# 3. Local state is initialized (scripts/fork/state.sh init).
# shellcheck disable=SC2016
functions=$(docker compose exec -T nuq-postgres sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null \
  <<<"select count(*) from pg_proc where proname in ('index_get_recent_5', 'monitoring_claim_due_monitors')")
[[ $functions == 2 ]] && ok "local state tables and functions" ||
  bad "local state tables and functions" "run scripts/fork/state.sh init"

# 4. Host agents are loaded (they start at login).
for label in dev.freecrawl.stealth-engine dev.freecrawl.ocr-service; do
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && ok "agent $label" || bad "agent $label" "not loaded"
done

# 5. Nothing but the API and the files server listens beyond the Docker network,
# and only on 127.0.0.1.
exposed=$(docker compose ps --format '{{.Service}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0|:::' || true)
[[ -z $exposed ]] && ok "no service published beyond 127.0.0.1" || bad "published beyond 127.0.0.1" "$exposed"

# 6. End to end.
scripts/fork/smoke.sh >/tmp/doctor-smoke.$$ 2>&1 && ok "smoke test" || bad "smoke test" "$(grep FAIL /tmp/doctor-smoke.$$ | head -3 | tr '\n' ' ')"
rm -f /tmp/doctor-smoke.$$

if [[ ${1:-} == --full ]]; then
  out=$(scripts/fork/gap-matrix.sh 2>&1)
  printf '%s\n' "$out" | grep -E ' FAIL ' || true
  ok "gap matrix: $(grep -c ' OK ' <<<"$out") OK, $(grep -c ' FAIL ' <<<"$out") FAIL (see above)"
fi

exit $failed
