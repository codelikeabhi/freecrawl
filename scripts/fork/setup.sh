#!/usr/bin/env bash
# Sets up Freecrawl on a fresh clone: Linux, macOS, or Windows under WSL 2.
# Needs Docker with Compose 2.24.4 or later, curl, jq and openssl.
#
#   scripts/fork/setup.sh [--no-ai] [--no-ocr] [--no-stealth] [--model NAME] [--env-only]
#
# Writes .env from fork/env.example with new secrets (an existing .env is
# kept), builds and starts the stack, creates the local state, pulls the
# model, then runs the doctor. Nothing is published beyond 127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")/../.."

ai=1 ocr=1 stealth=1 env_only=0 model=qwen3.5:9b
while (($#)); do
  case $1 in
    --no-ai) ai=0 ;;
    --no-ocr) ocr=0 ;;
    --no-stealth) stealth=0 ;;
    --model) model=$2; shift ;;
    --env-only) env_only=1 ;;
    *) sed -n '2,9p' "$0"; exit 2 ;;
  esac
  shift
done

for tool in docker curl jq openssl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
done
compose=$(docker compose version --short 2>/dev/null) || { echo "missing: docker compose"; exit 1; }
# docker-compose.override.yaml uses `ports: !override`, added in 2.24.4.
[[ $(printf '2.24.4\n%s\n' "${compose#v}" | sort -V | head -1) == 2.24.4 ]] ||
  { echo "Docker Compose $compose is too old: 2.24.4 or later is needed"; exit 1; }

# Docker Desktop on a Mac gives containers no GPU, so a running Ollama app is
# much faster than the ollama container.
host_ollama=0
if ((ai)) && [[ $(uname -s) == Darwin ]] &&
  curl -sf --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  host_ollama=1
fi

if [[ -f .env ]]; then
  echo ".env exists; keeping it"
else
  profiles="" ollama_url="" model_name=""
  ((stealth)) && profiles+=",stealth"
  ((ocr)) && profiles+=",ocr"
  if ((ai)); then
    if ((host_ollama)); then
      ollama_url=http://host.docker.internal:11434/api
      model_name="${model/:/-}-32k"
    else
      profiles+=",ollama" ollama_url=http://ollama:11434/api model_name=$model
    fi
  fi
  pg=$(openssl rand -hex 24)
  stealth_url="" ocr_url="" ocr_on=false
  ((stealth)) && stealth_url=http://stealth:3003/scrape
  ((ocr)) && ocr_url=http://ocr:3020 ocr_on=true
  (
    umask 077
    while IFS= read -r line; do
      while [[ $line == *@RANDOM@* ]]; do
        line=${line/@RANDOM@/$(openssl rand -hex 24)}
      done
      line=${line//@POSTGRES_PASSWORD@/$pg}
      line=${line//@PROFILES@/${profiles#,}}
      line=${line//@OLLAMA_BASE_URL@/$ollama_url}
      line=${line//@MODEL_NAME@/$model_name}
      line=${line//@FILES_DIR@/$PWD/data/files}
      line=${line//@STEALTH_URL@/$stealth_url}
      line=${line//@OCR_URL@/$ocr_url}
      line=${line//@OCR_ON@/$ocr_on}
      printf '%s\n' "$line"
    done <fork/env.example >.env
  )
  echo "wrote .env (services: ${profiles#,}${profiles:+, }core)"
fi
((env_only)) && exit 0

mkdir -p data/files
# --wait: until every container runs and the ones with a health check pass.
docker compose up -d --build --wait --wait-timeout 900

port=$(grep -E '^FORK_API_PORT=' .env | cut -d= -f2)
echo "waiting for the API on 127.0.0.1:${port:-3002}"
for _ in $(seq 1 120); do
  curl -sf --max-time 5 "http://127.0.0.1:${port:-3002}/v0/health/readiness" >/dev/null && break
  sleep 5
done
scripts/fork/state.sh init

model_name=$(grep -E '^MODEL_NAME=' .env | cut -d= -f2)
if [[ -n $model_name ]]; then
  if docker compose ps --services | grep -qx ollama; then
    docker compose exec -T ollama ollama pull "$model_name"
  elif ((host_ollama)) && command -v ollama >/dev/null; then
    # The app's default context is 4k on most Macs; the API budgets for 32k.
    ollama pull "$model"
    modelfile=$(mktemp)
    printf 'FROM %s\nPARAMETER num_ctx 32768\n' "$model" >"$modelfile"
    ollama create "$model_name" -f "$modelfile"
    rm -f "$modelfile"
  else
    echo "pull the model yourself: $model_name (with a 32k context)"
  fi
fi

scripts/fork/doctor.sh
