"""fork: /v2/agent behind the agent-service contract (PLAN.md Phase 15, D8 b).

The API forwards to EXTRACT_V3_BETA_URL (controllers/v2/agent*.ts,
lib/extract-v3-status.ts) with `Authorization: Bearer AGENT_INTEROP_SECRET`:
  POST   /internal/extracts                       start a run (answer 200)
  GET    /internal/extracts/:id                   {status: processing|success|failed, data, ...}
  DELETE /internal/extracts/:id                   cancel
  GET    /internal/recent-agents-for-team?teamId= recent runs for GET /v2/agent
  GET    /internal/extracts/:id/trace             {events: [...]} of this run's steps
  GET    /internal/threads/:id, .../snapshots/:s, .../skill   404: not offered
Progress is pulled: the API polls GET. Runs live in Redis for 24 h.

The loop, sized by `effort`: plan search queries with the local model ->
/v2/search (or only the given URLs with strictConstrainToURLs) -> /v2/scrape
each page with the user's schema as a json format (the API extracts with the
same model) -> one merge call -> validate against the schema. Credits are
summed from the API's own creditsUsed; past maxCredits (default 2500) the run
fails with stopReason credit_limit_reached and returns what it has as
`partial`. Webhooks (agent.started/action/completed/failed/cancelled) are
signed like the API's own (X-Firecrawl-Signature).
"""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import time
import uuid
from urllib.parse import urlparse

import httpx
import jsonschema
import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

API = os.environ.get("FIRECRAWL_URL", "http://api:3002")
OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/api").rstrip("/")
MODEL = os.environ.get("MODEL_NAME", "")
SECRET = os.environ.get("AGENT_INTEROP_SECRET", "")
HOOK_SECRET = os.environ.get("SELF_HOSTED_WEBHOOK_HMAC_SECRET", "")
LOCAL_HOOK_HOSTS = {h.strip().lower() for h in os.environ.get("FORK_WEBHOOK_LOCAL_HOSTS", "").split(",") if h.strip()}
TTL = 24 * 3600
EFFORT = {"low": (1, 3), "medium": (2, 5), "high": (3, 8)}  # (search queries, pages)
PAGE_CHARS = 6000  # markdown per page given to the model when there is no schema

app = FastAPI()
cache = aioredis.from_url(os.environ.get("REDIS_URL", "redis://redis:6379"))
http = httpx.AsyncClient(timeout=120, headers={"Authorization": "Bearer fc-local"})
cancelled: set[str] = set()


def fail(status: int, error: str) -> JSONResponse:
    return JSONResponse({"success": False, "error": error}, status_code=status)


def authorized(request: Request) -> bool:
    given = request.headers.get("authorization", "")
    return bool(SECRET) and hmac.compare_digest(given, f"Bearer {SECRET}")


async def load(job_id: str) -> dict | None:
    raw = await cache.get(f"fork-agent:{job_id}")
    return json.loads(raw) if raw else None


async def save(job: dict) -> None:
    await cache.set(f"fork-agent:{job['id']}", json.dumps(job), ex=TTL)


# ---------- webhooks ----------

def public_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if host in LOCAL_HOOK_HOSTS:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


async def webhook(job: dict, event: str, data, error: str | None = None) -> None:
    hook = job["options"].get("webhook")
    if not hook or not hook.get("url"):
        return
    events = hook.get("events") or ["started", "action", "completed", "failed", "cancelled"]
    if event not in events and f"agent.{event}" not in events:
        return
    if not await asyncio.to_thread(public_host, hook["url"]):
        return  # private addresses only when listed in FORK_WEBHOOK_LOCAL_HOSTS
    body = json.dumps({"success": error is None, "type": f"agent.{event}", "id": job["id"],
                       "webhookId": str(uuid.uuid4()), "data": data, "error": error,
                       "metadata": hook.get("metadata") or {}})
    headers = {"Content-Type": "application/json", **(hook.get("headers") or {})}
    if HOOK_SECRET:
        headers["X-Firecrawl-Signature"] = "sha256=" + hmac.new(HOOK_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    try:
        await http.post(hook["url"], content=body, headers=headers, timeout=10)
    except httpx.HTTPError:
        pass


# ---------- model ----------

async def ask_model(prompt: str, schema: dict) -> dict | None:
    if not MODEL:
        return None
    try:
        r = await http.post(f"{OLLAMA}/chat", json={
            "model": MODEL, "stream": False, "think": False, "format": schema,
            "options": {"temperature": 0}, "messages": [{"role": "user", "content": prompt}],
        }, timeout=180)
        return json.loads(r.json()["message"]["content"])
    except Exception:
        return None


# ---------- the loop ----------

class Stop(Exception):
    def __init__(self, reason: str):
        self.reason = reason


async def run(job: dict) -> None:
    opts = job["options"]
    prompt, schema = opts["prompt"], opts.get("schema")
    queries_n, pages_n = EFFORT.get(opts.get("effort") or "medium", EFFORT["medium"])
    max_credits = opts.get("maxCredits") or 2500
    trace, found = job["trace"], []

    async def step(kind: str, **fields):
        trace.append({"schemaVersion": 1, "type": kind, "at": int(time.time() * 1000), **fields})
        await save(job)
        if job["id"] in cancelled:
            raise Stop("cancelled")

    async def spend(response: dict, credits: int | None) -> None:
        job["creditsUsed"] += int(credits or 1)
        if job["creditsUsed"] > max_credits:
            raise Stop("credit_limit_reached")

    try:
        await step("run.started", prompt=prompt)
        await webhook(job, "started", {"prompt": prompt})
        urls = list(opts.get("urls") or [])
        if not (opts.get("strictConstrainToURLs") and urls):
            plan = await ask_model(
                f"Write up to {queries_n} short web search queries that would find the answer to this task. "
                f"Task: {prompt}" + (f"\nKnown starting URLs: {', '.join(urls)}" if urls else ""),
                {"type": "object", "properties": {"queries": {"type": "array", "items": {"type": "string"}}},
                 "required": ["queries"]},
            )
            queries = [q for q in (plan or {}).get("queries", []) if isinstance(q, str) and q.strip()][:queries_n] or [prompt[:200]]
            for q in queries:
                await step("tool_call.started", tool="search", input={"query": q})
                r = (await http.post(f"{API}/v2/search", json={"query": q, "limit": 5})).json()
                await spend(r, r.get("creditsUsed"))
                hits = [h["url"] for h in (r.get("data") or {}).get("web", []) if h.get("url")]
                urls += [u for u in hits if u not in urls]
                await step("tool_call.finished", tool="search", output={"urls": hits})
        for url in urls[:pages_n]:
            fmt = ["markdown", {"type": "json", "schema": schema, "prompt": prompt}] if schema else ["markdown"]
            await step("tool_call.started", tool="scrape", input={"url": url})
            r = (await http.post(f"{API}/v2/scrape", json={"url": url, "formats": fmt, "timeout": 60000})).json()
            doc = r.get("data") or {}
            await spend(r, (doc.get("metadata") or {}).get("creditsUsed"))
            if r.get("success"):
                found.append({"url": url, "json": doc.get("json"), "markdown": (doc.get("markdown") or "")[:PAGE_CHARS]})
            await step("tool_call.finished", tool="scrape", output={"url": url, "ok": bool(r.get("success"))})
            await webhook(job, "action", {"action": "scrape", "url": url})

        if not found:
            raise Stop("no pages could be read")
        await step("tool_call.started", tool="merge")
        sources = [f["url"] for f in found]
        # ponytail: a 9B model hallucinates when it fills gaps, so the merge sees
        # the page text next to each page's extraction and is told to check.
        rules = ("Rules: every value must be written in the page text below. When pages disagree, "
                 "take the value most pages support and prefer official sources. Never infer or "
                 "estimate a value from context. Keep repeated items when the task asks for a list "
                 "in page order.")
        per_page = max(1500, 20000 // len(found))
        if schema:
            evidence = "\n\n".join(
                f"Source: {f['url']}\nExtracted: {json.dumps(f['json'])}\nPage text: {f['markdown'][:per_page]}"
                for f in found)
            merged = await ask_model(
                f"Task: {prompt}\nCombine the sources into ONE answer that fits the schema.\n{rules}\n\n{evidence}",
                schema)
        else:
            pages = "\n\n".join(f"Source: {f['url']}\n{f['markdown'][:per_page]}" for f in found)
            merged = await ask_model(
                f"Answer the task using only these pages and say which source supports each fact. {rules} "
                f"If a requested fact is not in the pages, write that it is not stated in the sources.\n"
                f"Task: {prompt}\n\n{pages}",
                {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]})
            merged = merged and {"answer": merged.get("answer", ""), "sources": sources}
        if merged is None:
            raise Stop("the model returned no answer")
        if schema:
            jsonschema.validate(merged, schema)
        job.update(status="success", data=merged, completedAt=int(time.time() * 1000))
        await step("run.finished", outcome="success", sources=sources)
        await webhook(job, "completed", merged)
    except Stop as stop:
        partial = [f["json"] if schema else {"url": f["url"]} for f in found]
        job.update(status="failed", completedAt=int(time.time() * 1000))
        if stop.reason == "cancelled":
            job["error"] = "Agent was cancelled."
            await webhook(job, "cancelled", None, job["error"])
        else:
            job["error"] = "Credit limit reached." if stop.reason == "credit_limit_reached" else f"Agent failed: {stop.reason}."
            if stop.reason == "credit_limit_reached":
                job.update(stopReason="credit_limit_reached", partial=partial)
                if schema:
                    job["partialSchemaValid"] = all(_valid(p, schema) for p in partial if p is not None)
            await webhook(job, "failed", None, job["error"])
        trace.append({"schemaVersion": 1, "type": "run.finished", "at": int(time.time() * 1000), "outcome": stop.reason})
    except jsonschema.ValidationError as error:
        job.update(status="failed", error=f"The answer did not fit the schema: {error.message}",
                   partial=merged, partialSchemaValid=False, completedAt=int(time.time() * 1000))
        await webhook(job, "failed", None, job["error"])
    except Exception as error:  # an API or network failure ends the run, never the service
        job.update(status="failed", error=f"Agent failed: {error}", completedAt=int(time.time() * 1000))
        await webhook(job, "failed", None, job["error"])
    finally:
        cancelled.discard(job["id"])
        await save(job)


def _valid(value, schema) -> bool:
    try:
        jsonschema.validate(value, schema)
        return True
    except jsonschema.ValidationError:
        return False


# ---------- contract ----------

@app.post("/internal/extracts")
async def create(request: Request):
    if not authorized(request):
        return fail(401, "unauthorized")
    body = await request.json()
    opts = {k: body.get(k) for k in ("prompt", "urls", "schema", "effort", "maxCredits", "strictConstrainToURLs",
                                     "webhook", "mode", "safe")}
    opts["modelPreset"] = "spark-2"
    job = {"success": True, "id": body["id"], "teamId": body.get("teamId", ""), "status": "processing",
           "model": "spark-2", "effort": body.get("effort") or "medium", "mode": body.get("mode") or "extract",
           "creditsUsed": 0, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
           "options": opts, "trace": []}
    await save(job)
    await cache.zadd(f"fork-agent-team:{job['teamId']}", {job["id"]: time.time()})
    await cache.expire(f"fork-agent-team:{job['teamId']}", TTL)
    asyncio.create_task(run(job))
    return {}


PUBLIC = ("success", "id", "status", "data", "partial", "partialSchemaValid", "stopReason", "error", "model",
          "effort", "mode", "creditsUsed", "completedAt")


@app.get("/internal/extracts/{job_id}")
async def status(job_id: str, request: Request):
    if not authorized(request):
        return fail(401, "unauthorized")
    job = await load(job_id)
    return {k: job[k] for k in PUBLIC if k in job} if job else fail(404, "Agent job not found")


@app.delete("/internal/extracts/{job_id}")
async def cancel(job_id: str, request: Request):
    if not authorized(request):
        return fail(401, "unauthorized")
    job = await load(job_id)
    if not job:
        return fail(404, "Agent job not found")
    if job["status"] != "processing":
        return JSONResponse({"error": "Agent already finished"}, status_code=409)
    cancelled.add(job_id)
    return {"success": True}


@app.get("/internal/recent-agents-for-team")
async def recent(teamId: str, request: Request):
    if not authorized(request):
        return fail(401, "unauthorized")
    ids = await cache.zrevrange(f"fork-agent-team:{teamId}", 0, 99)
    out = []
    for raw in ids:
        job = await load(raw.decode())
        if job:
            state = {"processing": "processing", "success": "succeeded"}.get(job["status"], "failed")
            if job.get("stopReason") == "credit_limit_reached":
                state = "credit_limit_reached"
            elif job.get("error") == "Agent was cancelled.":
                state = "cancelled"
            out.append({"id": job["id"], "options": job["options"], "createdAt": job["createdAt"], "status": state})
    return out


@app.get("/internal/extracts/{job_id}/trace")
async def trace(job_id: str, request: Request):
    if not authorized(request):
        return fail(401, "unauthorized")
    job = await load(job_id)
    if not job:
        return fail(404, "Agent job not found")
    return {"success": True, "id": job_id, "events": job["trace"], "creditsUsed": job["creditsUsed"]}


@app.get("/internal/threads/{thread_id}")
async def thread(thread_id: str):
    return fail(404, "Threads are not available in the local agent service.")


@app.get("/internal/extracts/{job_id}/snapshots/{snapshot_id}")
async def snapshot(job_id: str, snapshot_id: str):
    return fail(404, "Snapshots are not available in the local agent service.")


@app.get("/internal/extracts/{job_id}/skill")
async def skill(job_id: str):
    return fail(404, "Skills are not available in the local agent service.")


@app.get("/health")
def health():
    return {"status": "healthy", "model": MODEL or None}
