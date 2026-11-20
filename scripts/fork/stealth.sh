#!/usr/bin/env bash
# Run the stealth engine on the host (PLAN.md Phase 6): apps/playwright-service-ts
# in stealth mode, Patchright driving the installed Chrome, bound to 127.0.0.1.
#
#   scripts/fork/stealth.sh start | stop | restart | status | logs
#
# The API reaches it at http://host.docker.internal:3003/scrape (FORK_STEALTH_URL).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PORT="${STEALTH_PORT:-3003}"
STATE=data/stealth
LOG="$STATE/engine.log"
PIDFILE="$STATE/engine.pid"
mkdir -p "$STATE"

running() { [[ -f $PIDFILE ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    [[ -d apps/stealth-engine/node_modules ]] || (cd apps/stealth-engine && pnpm install)
    # setsid-like: own process group, so stop can end pnpm, tsx and Chrome together.
    (cd apps/stealth-engine && exec nohup pnpm start) >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    for _ in $(seq 1 30); do
      curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && break
      sleep 1
    done
    "$0" status
    ;;
  stop)
    if running; then
      pkill -P "$(cat "$PIDFILE")" 2>/dev/null
      kill "$(cat "$PIDFILE")" 2>/dev/null
    fi
    # Belt and braces: the node process running the service, wherever it ended up.
    pkill -f "playwright-service-ts/api.ts" 2>/dev/null
    rm -f "$PIDFILE"
    echo "stopped"
    ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if curl -s --max-time 30 "http://127.0.0.1:$PORT/health"; then echo; else echo "not running"; exit 1; fi
    ;;
  logs) tail -n 50 "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|logs"; exit 2 ;;
esac
