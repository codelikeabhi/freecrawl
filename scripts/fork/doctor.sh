#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok/bad never fail, so A && ok || bad is safe
# Health check for the whole local stack (PLAN.md Phase 16). Run after setup,
# a restart, a sleep, or when something looks off. Linux, macOS, WSL 2.
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
  structured: "http://structured:8080/health",
  agent: "http://agent:8080/health",
  playwright: "http://playwright-service:3000/health",
};
// Optional services, checked wherever .env points them (a container, or the
// host on the owner Mac); not configured means not checked.
const base = name => (process.env[name] || "").replace(/\/+$/, "");
const optional = {
  stealth: base("FORK_STEALTH_URL").replace(/\/scrape$/, "") + "/health",
  ocr: base("FIRE_PDF_BASE_URL") + "/health",
  ollama: base("OLLAMA_BASE_URL") + "/tags",
};
for (const [name, url] of Object.entries(optional)) {
  if (url.startsWith("http")) checks[name] = url;
  else console.log(`SKIP  service ${name}  not configured in .env`);
}
// browser-sessions has no network; it answers on its Unix socket (404 = alive).
const undici = require("undici");
const viaSocket = new undici.Agent({ connect: { socketPath: "/sessions/hangar.sock" } });
undici.fetch("http://browser-sessions/v1/browsers/health-check", { dispatcher: viaSocket, signal: AbortSignal.timeout(10000) })
  .then(r => console.log(`${r.status === 404 ? "OK  " : "FAIL"}  service browser-sessions (socket)`))
  .catch(e => console.log(`FAIL  service browser-sessions (socket)  ${e.cause?.code ?? e.message}`));
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

# Postgres crash recoveries restart the API's workers (seen three times on
# 2026-11-21, cause unknown); report them so a pattern shows.
crashes=$(docker compose logs nuq-postgres --since 24h 2>/dev/null | grep -c "terminating any other active server processes")
[[ $crashes == 0 ]] && ok "postgres: no crash recoveries in 24 h" ||
  bad "postgres: $crashes crash recoveries in 24 h" "the API restarts with each; see docker compose logs nuq-postgres"

# 4. On a Mac, the host agents that .env points at are loaded (they start at
# login). Elsewhere these services run as containers, covered by step 1.
if [[ $(uname -s) == Darwin ]]; then
  for pair in FORK_STEALTH_URL:dev.freecrawl.stealth-engine FIRE_PDF_BASE_URL:dev.freecrawl.ocr-service; do
    docker compose exec -T api printenv "${pair%%:*}" 2>/dev/null | grep -q host.docker.internal || continue
    label=${pair#*:}
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && ok "agent $label" || bad "agent $label" "not loaded"
  done
fi

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
