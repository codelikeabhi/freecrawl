#!/usr/bin/env bash
# OCR service on the host (PLAN.md Phase 8): apps/ocr-service (MinerU, Apple
# GPU) speaking FirePDF's /ocr contract on 127.0.0.1:3020. The API reaches it
# at http://host.docker.internal:3020 (FIRE_PDF_BASE_URL).
#
#   scripts/fork/ocr.sh install-agent     copy the service, install deps, start at login
#   scripts/fork/ocr.sh uninstall-agent
#   scripts/fork/ocr.sh status | logs
#
# Like the stealth engine, it runs from ~/Library/Application Support because
# launchd agents may not read ~/Desktop. Re-run install-agent after editing
# apps/ocr-service/server.py.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PORT="${OCR_PORT:-3020}"
LABEL=dev.freecrawl.ocr-service
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME="$HOME/Library/Application Support/freecrawl-ocr"

agent_loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

case "${1:-status}" in
  install-agent)
    if agent_loaded; then launchctl bootout "gui/$(id -u)/$LABEL"; sleep 2; fi
    mkdir -p "$RUNTIME"
    [[ -x $RUNTIME/venv/bin/python ]] || uv venv --python 3.12 "$RUNTIME/venv" || exit 1
    uv pip install --quiet --python "$RUNTIME/venv/bin/python" -r apps/ocr-service/requirements.txt || exit 1
    # Models (~2 GB, Hugging Face cache) and their path in ~/mineru.json; quick once cached.
    "$RUNTIME/venv/bin/mineru-models-download" -s huggingface -m pipeline >/dev/null 2>&1 || { echo "model download failed"; exit 1; }
    cp apps/ocr-service/server.py "$RUNTIME/server.py"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME/venv/bin/python</string><string>-m</string><string>uvicorn</string>
    <string>server:app</string><string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$RUNTIME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$RUNTIME/service.log</string>
  <key>StandardErrorPath</key><string>$RUNTIME/service.log</string>
</dict>
</plist>
PLISTEOF
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null ||
      { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
    # The first start imports torch and MinerU, which takes a while.
    for _ in $(seq 1 90); do
      curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" && break
      sleep 2
    done
    "$0" status
    ;;
  uninstall-agent)
    if agent_loaded; then launchctl bootout "gui/$(id -u)/$LABEL"; fi
    rm -f "$PLIST"
    echo "agent removed (the venv and models stay in $RUNTIME and the Hugging Face cache)"
    ;;
  status)
    if [[ -f $RUNTIME/server.py ]] && ! cmp -s apps/ocr-service/server.py "$RUNTIME/server.py"; then
      echo "warning: the agent runs an older copy of server.py; run: $0 install-agent"
    fi
    if curl -s --max-time 10 "http://127.0.0.1:$PORT/health"; then echo; else echo "not running"; exit 1; fi
    ;;
  logs) tail -n 50 "$RUNTIME/service.log" ;;
  *) echo "usage: $0 install-agent|uninstall-agent|status|logs"; exit 2 ;;
esac
