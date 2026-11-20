#!/usr/bin/env bash
# Run the stealth engine on the host (PLAN.md Phase 6): apps/playwright-service-ts
# in stealth mode, Patchright driving the installed Chrome, bound to 127.0.0.1.
#
#   scripts/fork/stealth.sh start | stop | restart | status | logs
#   scripts/fork/stealth.sh install-agent | uninstall-agent   (start at login)
#
# The API reaches it at http://host.docker.internal:3003/scrape (FORK_STEALTH_URL).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PORT="${STEALTH_PORT:-3003}"
STATE=data/stealth
LOG="$STATE/engine.log"
PIDFILE="$STATE/engine.pid"
LABEL=dev.freecrawl.stealth-engine
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# launchd agents may not read ~/Desktop (macOS privacy), so the agent runs a
# copy of the engine from here, with its profiles and log. Re-run
# install-agent after changing apps/playwright-service-ts/api.ts.
RUNTIME="$HOME/Library/Application Support/freecrawl-stealth"
mkdir -p "$STATE"

running() { [[ -f $PIDFILE ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
agent_installed() { [[ -f $PLIST ]]; }
agent_loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }
wait_healthy() {
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && return 0
    sleep 1
  done
}

# Ends the engine whatever started it: launchd, this script, or an orphan
# that kept the port. Waits until the port is free.
kill_engine() {
  local pids
  pids=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
  pkill -f "playwright-service-ts/api.ts" 2>/dev/null
  # shellcheck disable=SC2086
  [[ -n $pids ]] && kill $pids 2>/dev/null
  for _ in $(seq 1 20); do
    lsof -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  # Playwright's own SIGTERM handler closes Chrome but may leave node running.
  # Chrome exits on its own once node's control pipe closes.
  pids=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
  # shellcheck disable=SC2086
  [[ -n $pids ]] && kill -9 $pids 2>/dev/null
  sleep 1
}
unload_agent() {
  agent_loaded || return 0
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  for _ in $(seq 1 20); do agent_loaded || return 0; sleep 0.5; done
}

case "${1:-status}" in
  install-agent)
    # launchd runs the engine in the foreground at login and restarts it if it
    # dies. Its PATH is minimal, so node and pnpm are found here and baked in.
    "$0" stop >/dev/null 2>&1
    mkdir -p "$RUNTIME/stealth-engine" "$RUNTIME/playwright-service-ts" "$RUNTIME/profiles"
    rsync -a --delete --exclude node_modules apps/stealth-engine/ "$RUNTIME/stealth-engine/"
    rsync -a --delete --exclude '*.spec.ts' apps/playwright-service-ts/api.ts \
      apps/playwright-service-ts/helpers "$RUNTIME/playwright-service-ts/"
    (cd "$RUNTIME/stealth-engine" && pnpm install --frozen-lockfile >/dev/null) || exit 1
    bin_path="$(dirname "$(command -v pnpm)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v pnpm)</string><string>start</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME/stealth-engine</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$bin_path</string>
    <key>STEALTH_PROFILE_DIR</key><string>$RUNTIME/profiles</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RUNTIME/engine.log</string>
  <key>StandardErrorPath</key><string>$RUNTIME/engine.log</string>
</dict>
</plist>
PLISTEOF
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null ||
      { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
    wait_healthy
    "$0" status
    ;;
  uninstall-agent)
    unload_agent
    rm -f "$PLIST"
    kill_engine
    echo "agent removed"
    ;;
  start)
    if agent_installed; then
      agent_loaded || launchctl bootstrap "gui/$(id -u)" "$PLIST"
      wait_healthy
      "$0" status
      exit $?
    fi
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
    # Under the agent, launchd would restart a killed process; unload it first.
    unload_agent
    if running; then
      pkill -P "$(cat "$PIDFILE")" 2>/dev/null
      kill "$(cat "$PIDFILE")" 2>/dev/null
    fi
    kill_engine
    rm -f "$PIDFILE"
    echo "stopped"
    ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if agent_installed && ! cmp -s apps/playwright-service-ts/api.ts "$RUNTIME/playwright-service-ts/api.ts"; then
      echo "warning: the agent runs an older copy of api.ts; run: $0 install-agent"
    fi
    if curl -s --max-time 30 "http://127.0.0.1:$PORT/health"; then echo; else echo "not running"; exit 1; fi
    ;;
  logs) if agent_installed; then tail -n 50 "$RUNTIME/engine.log"; else tail -n 50 "$LOG"; fi ;;
  *) echo "usage: $0 start|stop|restart|status|logs|install-agent|uninstall-agent"; exit 2 ;;
esac
