"""fork: research, developer and gov search indexes (PLAN.md Phase 3b, G18).

Speaks the two contracts the API forwards to (apps/api/src/lib/research-upstream.ts):
  RESEARCH_PROXY_URL   GET /v2/research/papers, /v2/research/papers/{id}[/similar],
                       GET /v2/research/proteins, GET /v2/code/search
  SEARCH_PLATFORM_URL  POST /api/v1/gov-search
The API passes our JSON through, so these bodies are the public responses
(shapes: apps/js-sdk/firecrawl/src/v2/types.ts).

Firecrawl answers these from its own crawled indexes; we use free, keyless
public APIs instead, so results differ from Cloud:
  papers    OpenAlex (search, related, citers, references) + arXiv (metadata,
            categories); passages come from the paper's PDF scraped by our API
  proteins  UniProtKB REST
  developer GitHub search (issues, PRs, READMEs) + Stack Overflow + SearXNG docs
  gov       eCFR + Federal Register + SearXNG results on .gov sites
Upstream calls are cached in Redis and spaced per host to respect each API's
published limits. Runs on the Docker backend network only.
"""

import asyncio
import hashlib
import html
import json
import math
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

SEARXNG = os.environ.get("SEARXNG_URL", "http://searxng:8080")
FIRECRAWL = os.environ.get("FIRECRAWL_URL", "http://api:3002")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN") or None
DAY = 24 * 3600

app = FastAPI()
cache = aioredis.from_url(os.environ.get("REDIS_URL", "redis://redis:6379"))
client = httpx.AsyncClient(
    timeout=30, follow_redirects=True, headers={"User-Agent": "freecrawl-indexes/0.1 (self-hosted)"}
)

# Seconds between calls per host, from each API's published limits.
SPACING = {
    "export.arxiv.org": 3.0,
    "api.github.com": 2.0 if GITHUB_TOKEN else 6.0,  # search: 30/min with a token, 10/min without
    "api.openalex.org": 0.1,
    "rest.uniprot.org": 0.1,
    "api.stackexchange.com": 0.2,
}
_locks: dict[str, asyncio.Lock] = {}
_last: dict[str, float] = {}


async def wait_turn(host: str) -> None:
    async with _locks.setdefault(host, asyncio.Lock()):
        delay = _last.get(host, 0.0) + SPACING.get(host, 0.2) - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        _last[host] = time.monotonic()


async def cached(key_parts: list, ttl: int, produce):
    key = "fork-idx:" + hashlib.sha256(json.dumps(key_parts, default=str).encode()).hexdigest()
    try:
        if (hit := await cache.get(key)) is not None:
            return json.loads(hit)
    except Exception:
        pass  # ponytail: the cache is best effort; a Redis hiccup only costs speed
    value = await produce()
    if value in (None, ""):  # a miss or a failed scrape is retried next time
        return value
    try:
        await cache.set(key, json.dumps(value), ex=ttl)
    except Exception:
        pass
    return value


async def fetch(url: str, params=None, kind: str = "json", ttl: int = DAY, headers=None):
    """GET with cache and per-host spacing. 404 gives None. kind: json, text, full."""

    async def produce():
        await wait_turn(urlparse(url).hostname or "")
        r = await client.get(url, params=params, headers=headers)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        if kind == "text":
            return r.text
        if kind == "full":
            return {"json": r.json(), "headers": {k.lower(): v for k, v in r.headers.items()}}
        return r.json()

    return await cached([url, params, kind], ttl, produce)


async def scrape_markdown(url: str, parsers=None, timeout: float = 85) -> str:
    """Markdown of a page or PDF through our own API (its robots rules apply)."""

    async def produce():
        body = {"url": url, "formats": ["markdown"], **({"parsers": parsers} if parsers else {})}
        try:
            r = await client.post(f"{FIRECRAWL}/v2/scrape", json=body, timeout=timeout)
        except httpx.TimeoutException:
            return ""
        return ((r.json().get("data") or {}).get("markdown") or "") if r.status_code == 200 else ""

    return await cached(["scrape", url, parsers], 7 * DAY, produce)


# ---------- text helpers ----------

WORD = re.compile(r"[a-z0-9]+")
TAG = re.compile(r"<[^>]+>")


def words(text: str) -> list[str]:
    return WORD.findall(text.lower())


def plain(text: str | None) -> str:
    return " ".join(html.unescape(TAG.sub(" ", text or "")).split())


def bm25(query: str, docs: list[str], k1: float = 1.2, b: float = 0.75) -> list[float]:
    q = set(words(query))
    toks = [words(d) for d in docs]
    sets = [set(t) for t in toks]
    n = len(docs) or 1
    avg = (sum(map(len, toks)) / n) or 1
    idf = {t: math.log(1 + (n - df + 0.5) / (df + 0.5)) for t in q for df in [sum(t in s for s in sets)]}
    scores = []
    for doc in toks:
        tf: dict[str, int] = {}
        for w in doc:
            if w in q:
                tf[w] = tf.get(w, 0) + 1
        norm = k1 * (1 - b + b * len(doc) / avg)
        scores.append(sum(idf[w] * f * (k1 + 1) / (f + norm) for w, f in tf.items()))
    return scores


def normalized(scores: list[float]) -> list[float]:
    top = max(scores, default=0) or 1
    return [round(s / top, 4) for s in scores]


def chunks(text: str, size: int) -> list[str]:
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if cur and len(cur) + len(para) > size:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


def best_passages(query: str, text: str, n: int, size: int) -> list[tuple[str, float]]:
    parts = chunks(text, size)
    scores = normalized(bm25(query, parts))
    return sorted(zip(parts, scores), key=lambda p: -p[1])[:n]


def fail(status: int, error: str) -> JSONResponse:
    return JSONResponse({"success": False, "error": error}, status_code=status)


@app.exception_handler(httpx.HTTPError)
async def upstream_failed(_: Request, error: httpx.HTTPError):
    return fail(502, f"upstream request failed: {error}")


@app.get("/health")
async def health():
    return {"status": "healthy"}


# ---------- papers ----------

OA = "https://api.openalex.org"
ARXIV = "https://export.arxiv.org/api/query"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
ARXIV_ID = re.compile(r"(\d{4}\.\d{4,5}|[a-z][a-z.\-]*/\d{7})(v\d+)?", re.I)
ARXIV_IN_URL = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|10\.48550/arxiv\.)([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$", re.I)


def oa_ids(work: dict) -> dict[str, list[str]]:
    raw, ids = work.get("ids") or {}, {}
    if raw.get("doi"):
        ids["doi"] = [raw["doi"].removeprefix("https://doi.org/")]
    if raw.get("pmid"):
        ids["pmid"] = [raw["pmid"].rstrip("/").rsplit("/", 1)[-1]]
    if raw.get("pmcid"):
        pmcid = raw["pmcid"].rstrip("/").rsplit("/", 1)[-1]
        ids["pmcid"] = [pmcid if pmcid.upper().startswith("PMC") else f"PMC{pmcid}"]
    if raw.get("openalex"):
        ids["openalex"] = [raw["openalex"].rsplit("/", 1)[-1]]
    urls = [raw.get("doi") or ""] + [loc.get("landing_page_url") or "" for loc in work.get("locations") or []]
    for url in urls:
        if m := ARXIV_IN_URL.search(url):
            ids["arxiv"] = [m.group(1)]
            break
    return ids


def primary_id(ids: dict[str, list[str]]) -> str:
    for key in ("arxiv", "pmid", "pmcid", "doi", "openalex"):
        if ids.get(key):
            return f"{key}:{ids[key][0]}"
    return ""


def oa_abstract(work: dict) -> str:
    inv = work.get("abstract_inverted_index") or {}
    return " ".join(w for _, w in sorted((p, w) for w, ps in inv.items() for p in ps))


def oa_paper(work: dict, score: float) -> dict:
    ids = oa_ids(work)
    pid = primary_id(ids)
    paper = {
        "paperId": pid,
        "primaryId": pid,
        "ids": ids,
        "title": work.get("display_name") or "",
        "abstract": oa_abstract(work),
        "authors": [a["author"]["display_name"] for a in work.get("authorships") or [] if a.get("author")],
        "score": round(score, 4),
    }
    if work.get("publication_date"):
        paper["createdDate"] = work["publication_date"]
    if work.get("updated_date"):
        paper["updateDate"] = work["updated_date"][:10]
    return paper


def arxiv_entries(xml: str) -> list[dict]:
    out = []
    for e in ET.fromstring(xml).findall("a:entry", ATOM):
        url = e.findtext("a:id", "", ATOM)
        if "/abs/" not in url:  # arXiv reports errors as an entry
            continue
        aid = re.sub(r"v\d+$", "", url.rsplit("/abs/", 1)[-1])
        out.append(
            {
                "ids": {"arxiv": [aid]},
                "title": " ".join(e.findtext("a:title", "", ATOM).split()),
                "abstract": " ".join(e.findtext("a:summary", "", ATOM).split()),
                "authors": [a.findtext("a:name", "", ATOM) for a in e.findall("a:author", ATOM)],
                "categories": [c.get("term") for c in e.findall("a:category", ATOM)],
                "createdDate": e.findtext("a:published", "", ATOM)[:10],
                "updateDate": e.findtext("a:updated", "", ATOM)[:10],
            }
        )
    return out


def parse_id(pid: str) -> tuple[str, str]:
    pid = pid.strip()
    if m := re.match(r"^(arxiv|pmid|pmcid|doi|openalex):(.+)$", pid, re.I):
        kind, value = m.group(1).lower(), m.group(2)
    elif ARXIV_ID.fullmatch(pid):
        kind, value = "arxiv", pid
    elif pid.startswith("10."):
        kind, value = "doi", pid
    elif re.fullmatch(r"W\d+", pid, re.I):
        kind, value = "openalex", pid.upper()
    elif re.fullmatch(r"PMC\d+", pid, re.I):
        kind, value = "pmcid", pid.upper()
    elif pid.isdigit():
        kind, value = "pmid", pid
    else:
        return "", pid
    if kind == "arxiv":
        value = re.sub(r"v\d+$", "", value)
    return kind, value


async def oa_work(pid: str) -> dict | None:
    kind, value = parse_id(pid)
    lookup = {
        "arxiv": f"doi:10.48550/arXiv.{value}",
        "doi": f"doi:{value}",
        "pmid": f"pmid:{value}",
        "pmcid": f"pmcid:{value}",
        "openalex": value,
    }.get(kind)
    return await fetch(f"{OA}/works/{lookup}") if lookup else None


async def metadata(pid: str) -> tuple[dict | None, dict | None]:
    """(public PaperMetadata, OpenAlex work). arXiv is the authority for arXiv ids."""
    kind, value = parse_id(pid)
    try:
        work = await oa_work(pid)
    except httpx.HTTPError:
        if kind != "arxiv":
            raise
        work = None  # arXiv still answers for its own ids
    if kind == "arxiv":
        entries = arxiv_entries(await fetch(ARXIV, {"id_list": value}, kind="text"))
        if entries:
            e = entries[0]
            ids = {**(oa_ids(work) if work else {}), **e["ids"]}
            meta = {"paperId": primary_id(ids), "ids": ids, "title": e["title"], "abstract": e["abstract"],
                    "authors": ", ".join(e["authors"]), "categories": e["categories"],
                    "createdDate": e["createdDate"], "updateDate": e["updateDate"]}
            return meta, work
    if not work:
        return None, None
    p = oa_paper(work, 0)
    meta = {k: p[k] for k in ("paperId", "ids", "title", "abstract") if k in p}
    if p["authors"]:
        meta["authors"] = ", ".join(p["authors"])
    for k in ("createdDate", "updateDate"):
        if k in p:
            meta[k] = p[k]
    return meta, work


@app.get("/v2/research/papers")
async def search_papers(
    query: str,
    k: int = 40,
    authors: list[str] | None = Query(None),
    categories: list[str] | None = Query(None),
    date_from: str | None = Query(None, alias="from"),
    to: str | None = None,
    sort: str = "relevance",
):
    if categories:  # arXiv categories: only arXiv knows them
        q = " AND ".join(f"all:{w}" for w in words(query))
        q += " AND (" + " OR ".join(f"cat:{c}" for c in categories) + ")"
        if authors:
            q += " AND (" + " OR ".join(f'au:"{a}"' for a in authors) + ")"
        if date_from or to:
            lo = (date_from or "1991-01-01").replace("-", "") + "0000"
            hi = (to or "2999-12-31").replace("-", "") + "2359"
            q += f" AND submittedDate:[{lo} TO {hi}]"
        params = {"search_query": q, "max_results": min(k, 200), "sortOrder": "descending",
                  "sortBy": "submittedDate" if sort == "date_desc" else "relevance"}
        entries = arxiv_entries(await fetch(ARXIV, params, kind="text"))
        results = []
        for i, e in enumerate(entries[:k]):
            pid = primary_id(e["ids"])
            results.append({"paperId": pid, "primaryId": pid, "ids": e["ids"], "title": e["title"],
                            "abstract": e["abstract"], "authors": e["authors"], "createdDate": e["createdDate"],
                            "updateDate": e["updateDate"], "score": round(1 / (1 + i), 4)})
        return {"success": True, "results": results}

    filters = []
    if date_from:
        filters.append(f"from_publication_date:{date_from}")
    if to:
        filters.append(f"to_publication_date:{to}")
    # ponytail: OpenAlex pages hold 200; k up to 500 is capped there. Authors are
    # matched on the page we get, so ask for a full page when filtering by them.
    params = {"search": query, "per-page": 200 if authors else min(k, 200)}
    if filters:
        params["filter"] = ",".join(filters)
    if sort == "date_desc":
        params["sort"] = "publication_date:desc"
    works = (await fetch(f"{OA}/works", params))["results"]
    papers = [oa_paper(w, w.get("relevance_score") or 0) for w in works]
    if authors:
        wanted = [a.lower() for a in authors]
        papers = [p for p in papers if any(w in name.lower() for w in wanted for name in p["authors"])]
    return {"success": True, "results": [p for p in papers if p["paperId"]][:k]}


async def oa_by_ids(work_ids: list[str]) -> list[dict]:
    found = []
    for i in range(0, len(work_ids), 50):
        batch = "|".join(work_ids[i : i + 50])
        found += (await fetch(f"{OA}/works", {"filter": f"openalex_id:{batch}", "per-page": 50}))["results"]
    return found


def short_id(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


@app.get("/v2/research/papers/{pid:path}/similar")
async def similar_papers(
    pid: str,
    intent: str,
    mode: str = "similar",
    k: int = 40,
    rerank: bool = True,
    anchor: list[str] | None = Query(None),
):
    seeds = [w for w in await asyncio.gather(*(oa_work(x) for x in [pid, *(anchor or [])])) if w]
    if not seeds:
        return fail(404, f"paper not found: {pid}")
    seed_ids = {short_id(s["id"]) for s in seeds}
    links: dict[str, int] = {}  # candidate -> number of seeds that reach it
    pool: dict[str, dict] = {}
    for seed in seeds:
        if mode == "citers":
            found = (await fetch(f"{OA}/works", {"filter": f"cites:{short_id(seed['id'])}",
                                                 "per-page": 100, "sort": "cited_by_count:desc"}))["results"]
            ids = [short_id(w["id"]) for w in found]
            pool.update({short_id(w["id"]): w for w in found})
        else:
            ids = [short_id(u) for u in seed.get("referenced_works" if mode == "references" else "related_works") or []]
        for wid in ids:
            links[wid] = links.get(wid, 0) + 1
    missing = [wid for wid in links if wid not in pool]
    pool.update({short_id(w["id"]): w for w in await oa_by_ids(missing)})
    if mode == "similar":  # widen the pool with an intent search, as Cloud's semantic leg does
        for w in (await fetch(f"{OA}/works", {"search": intent, "per-page": 25}))["results"]:
            pool.setdefault(short_id(w["id"]), w)
    for wid in seed_ids:
        pool.pop(wid, None)
    works = list(pool.values())
    semantic = normalized(bm25(intent, [f"{w.get('display_name') or ''} {oa_abstract(w)}" for w in works]))
    top_cites = max((w.get("cited_by_count") or 0 for w in works), default=0)
    results = []
    for w, sem in zip(works, semantic):
        overlap = links.get(short_id(w["id"]), 0)
        rank = math.log1p(w.get("cited_by_count") or 0) / (math.log1p(top_cites) or 1)
        structural = overlap / len(seeds)
        score = 0.5 * sem + 0.3 * structural + 0.2 * rank if rerank else 0.6 * structural + 0.4 * rank
        paper = oa_paper(w, score)
        paper["signals"] = {"structural": overlap, "semantic": sem, "articleRank": round(rank, 4), "seedOverlap": overlap}
        if paper["paperId"]:
            results.append(paper)
    results.sort(key=lambda p: -p["score"])
    body = {"success": True, "results": results[:k], "poolSize": len(results), "truncated": len(results) > k}
    if not results:
        body["note"] = f"no {mode} papers found for {pid}"
    return body


@app.get("/v2/research/papers/{pid:path}")
async def paper(pid: str, query: str | None = None, k: int = 4):
    meta, work = await metadata(pid)
    if not meta:
        return fail(404, f"paper not found: {pid}")
    if query is None:
        return {"success": True, "paper": meta}
    # Clean text first: arXiv's HTML (built from LaTeX), then the PDF with full
    # layout parsing (OCR service; 40 pages fit the API's 120 s read budget),
    # then the PDF's raw text layer (fast, but words run together on columns).
    ids, pdfs = meta["ids"], []
    if ids.get("arxiv"):
        pdfs.append(f"https://arxiv.org/pdf/{ids['arxiv'][0]}")
    if work:
        pdfs += [(work.get("best_oa_location") or {}).get("pdf_url"), (work.get("open_access") or {}).get("oa_url")]
    pdfs = list(dict.fromkeys(filter(None, pdfs)))[:1]
    attempts = [(f"https://arxiv.org/html/{ids['arxiv'][0]}", None, 30)] if ids.get("arxiv") else []
    for url in pdfs:
        attempts += [(url, [{"type": "pdf", "maxPages": 40}], 80), (url, [{"type": "pdf", "mode": "fast"}], 20)]
    text = ""
    for url, parsers, timeout in attempts:
        if len(text := await scrape_markdown(url, parsers, timeout)) > 2000:
            break
    text = text or f"{meta['title']}\n\n{meta['abstract']}"
    passages = [{"text": t, "score": s} for t, s in best_passages(query, text, k, 1200)]
    return {"success": True, "paper": meta, "paperId": meta["paperId"], "query": query, "passages": passages}


# ---------- proteins ----------

UNIPROT = "https://rest.uniprot.org/uniprotkb"
ACCESSION = re.compile(r"[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2}")
NOTICE = "Protein data from UniProtKB (the UniProt Consortium), licensed under CC BY 4.0: https://www.uniprot.org"
ECO_KIND = {
    "ECO:0000269": "experimental", "ECO:0007005": "large_scale_experimental",
    "ECO:0007744": "large_scale_experimental", "ECO:0000303": "author_statement",
    "ECO:0000304": "author_statement", "ECO:0000305": "curator_inference", "ECO:0000250": "by_similarity",
    "ECO:0000255": "sequence_analysis", "ECO:0000256": "sequence_analysis",
    "ECO:0000259": "sequence_analysis", "ECO:0000312": "imported", "ECO:0000313": "imported",
}


def evidence(items: list | None) -> list[dict]:
    out = []
    for ev in items or []:
        item = {"kind": ECO_KIND.get(ev.get("evidenceCode", ""), "untagged")}
        if ev.get("evidenceCode"):
            item["eco"] = ev["evidenceCode"]
        if ev.get("source") == "PubMed" and ev.get("id"):
            item["paperId"] = f"pmid:{ev['id']}"
        elif ev.get("source") == "UniProtKB" and item["kind"] == "by_similarity":
            item["fromProtein"] = ev.get("id")
        out.append(item)
    return out


def candidate(e: dict, matched_by: str) -> dict:
    desc = e.get("proteinDescription") or {}
    name = ((desc.get("recommendedName") or {}).get("fullName") or {}).get("value")
    if not name and desc.get("submissionNames"):
        name = desc["submissionNames"][0]["fullName"]["value"]
    org = e.get("organism") or {}
    c = {"accession": e["primaryAccession"], "entryName": e.get("uniProtkbId", ""), "name": name or "",
         "organism": {"taxonId": org.get("taxonId"), "scientificName": org.get("scientificName", "")},
         "matchedBy": matched_by}
    if org.get("commonName"):
        c["organism"]["commonName"] = org["commonName"]
    genes = e.get("genes") or []
    if genes and genes[0].get("geneName"):
        c["gene"] = genes[0]["geneName"]["value"]
    return c


def protein_entry(e: dict, matched_by: str) -> dict:
    entry = candidate(e, matched_by)
    synonyms = [s["value"] for g in e.get("genes") or [] for s in g.get("synonyms") or []]
    desc = e.get("proteinDescription") or {}
    synonyms += [a["fullName"]["value"] for a in desc.get("alternativeNames") or [] if a.get("fullName")]
    function, location = [], []
    for c in e.get("comments") or []:
        if c.get("commentType") == "FUNCTION":
            function += [{"text": t["value"], "note": False, "evidence": evidence(t.get("evidences"))}
                         for t in c.get("texts") or []]
        elif c.get("commentType") == "SUBCELLULAR LOCATION":
            for loc in c.get("subcellularLocations") or []:
                s = {"text": loc["location"]["value"], "note": False, "evidence": evidence(loc["location"].get("evidences"))}
                for key in ("topology", "orientation"):
                    if loc.get(key):
                        s[key] = loc[key]["value"]
                if c.get("molecule"):
                    s["molecule"] = c["molecule"]
                location.append(s)
            location += [{"text": t["value"], "note": True, "evidence": evidence(t.get("evidences"))}
                         for t in (c.get("note") or {}).get("texts") or []]
    go = []
    for x in e.get("uniProtKBCrossReferences") or []:
        props = {p["key"]: p["value"] for p in x.get("properties") or []}
        if x.get("database") == "GO" and props.get("GoTerm", "").startswith("C:"):
            code, _, by = props.get("GoEvidenceType", "").partition(":")
            go.append({"id": x["id"], "term": props["GoTerm"][2:], "code": code, "assignedBy": by,
                       "paperIds": [p["paperId"] for p in evidence(x.get("evidences")) if "paperId" in p]})
    papers = [f"pmid:{x['id']}" for r in e.get("references") or []
              for x in (r.get("citation") or {}).get("citationCrossReferences") or [] if x.get("database") == "PubMed"]
    entry.update({"synonyms": synonyms, "url": f"https://www.uniprot.org/uniprotkb/{entry['accession']}/entry",
                  "subcellularLocation": location, "function": function, "goCellularComponent": go,
                  "paperIds": papers})
    return entry


@app.get("/v2/research/proteins")
async def proteins(protein: str, organism: str = "9606"):
    p, org = protein.strip(), organism.strip()
    org_q = f"organism_id:{org}" if org.isdigit() else f'organism_name:"{org}"'
    attempts = []
    if ACCESSION.fullmatch(p.upper()):
        attempts.append(("accession", f"accession:{p.upper()}"))
    if "_" in p:
        attempts.append(("entry_name", f"id:{p.upper()}"))
    attempts += [("gene", f"gene_exact:{p}"), ("name", f'protein_name:"{p}"')]
    release = ""
    for matched_by, q in attempts:
        # Reviewed (Swiss-Prot) entries first; unreviewed only if nothing else matches.
        for reviewed in (" AND reviewed:true", ""):
            org_part = "" if matched_by == "accession" else f" AND ({org_q})"
            res = await fetch(f"{UNIPROT}/search", {"query": f"({q}){org_part}{reviewed}", "size": 10,
                                                    "format": "json"}, kind="full")
            hits, headers = res["json"].get("results") or [], res["headers"]
            release = headers.get("x-uniprot-release", release)
            if not hits:
                continue
            base = {"success": True, "release": release, "notice": NOTICE}
            if len(hits) == 1:
                full = await fetch(f"{UNIPROT}/{hits[0]['primaryAccession']}.json")
                return {**base, "match": "found", "protein": protein_entry(full, matched_by)}
            total = int(headers.get("x-total-results", len(hits)))
            return {**base, "match": "ambiguous", "candidates": [candidate(h, matched_by) for h in hits[:10]],
                    "candidateCount": total}
    return {"success": True, "release": release, "notice": NOTICE, "match": "not_found"}


# ---------- developer ----------

GITHUB = "https://api.github.com"


def github_headers() -> dict:
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return h


async def github_threads(query, k, kinds, repos, language) -> list[dict]:
    q = [query, *(f"repo:{r}" for r in repos)]
    if language:
        q.append(f"language:{language}")
    if kinds == {"issue"}:
        q.append("type:issue")
    elif kinds == {"pull_request"}:
        q.append("type:pr")
    found = await fetch(f"{GITHUB}/search/issues", {"q": " ".join(q), "per_page": min(k, 30)},
                        headers=github_headers())
    out = []
    for item in (found or {}).get("items", []):
        kind = "pull_request" if "pull_request" in item else "issue"
        repo = item["repository_url"].split("/repos/", 1)[-1]
        out.append({"id": f"github:{kind}:{repo}#{item['number']}", "url": item["html_url"],
                    "title": item["title"], "_text": item.get("body") or ""})
    return out


async def github_readmes(query, k, repos, language, topic, license, min_stars, max_stars, archived, fork, skills):
    q = [query, *(f"repo:{r}" for r in repos), *(f"topic:{t}" for t in topic)]
    if language:
        q.append(f"language:{language}")
    if license:
        q.append(f"license:{license.lower()}")
    if min_stars is not None or max_stars is not None:
        q.append(f"stars:{min_stars or 0}..{max_stars if max_stars is not None else '*'}")
    if archived is not None:
        q.append(f"archived:{str(archived).lower()}")
    if fork:
        q.append("fork:only")
    if skills == "only":  # ponytail: packaged skills ship a SKILL.md; README mention is the closest search
        q.append("SKILL.md in:readme")
    found = await fetch(f"{GITHUB}/search/repositories", {"q": " ".join(q), "per_page": min(k, 10)},
                        headers=github_headers())
    repos_found = (found or {}).get("items", [])
    readmes = await asyncio.gather(
        *(fetch(f"https://raw.githubusercontent.com/{r['full_name']}/HEAD/README.md", kind="text") for r in repos_found),
        return_exceptions=True,
    )
    out = []
    for r, readme in zip(repos_found, readmes):
        text = readme if isinstance(readme, str) else (r.get("description") or "")
        out.append({"id": f"github:readme:{r['full_name']}", "url": f"{r['html_url']}#readme",
                    "title": r["full_name"], "_text": text})
    return out


async def stackoverflow(query, k, language) -> list[dict]:
    params = {"q": query, "site": "stackoverflow", "order": "desc", "sort": "relevance",
              "pagesize": min(k, 20), "filter": "withbody"}
    if language:
        params["tagged"] = language.lower()
    found = await fetch("https://api.stackexchange.com/2.3/search/advanced", params)
    return [{"id": f"stackoverflow:question:{q['question_id']}", "url": q["link"], "title": plain(q["title"]),
             "_text": plain(q.get("body"))} for q in (found or {}).get("items", [])]


async def searxng(query: str, k: int, categories: str = "general") -> list[dict]:
    found = await fetch(f"{SEARXNG}/search", {"q": query, "format": "json", "categories": categories})
    return [r for r in (found or {}).get("results", []) if r.get("url")][: max(k, 10)]


async def docs(query, k, sources) -> list[dict]:
    queries = [f"{query} site:{s}" for s in sources if "." in s] or [f"{query} documentation"]
    found = await asyncio.gather(*(searxng(q, k, "it") for q in queries))
    return [{"id": f"doc:{r['url']}", "url": r["url"], "title": r.get("title") or r["url"],
             "_text": r.get("content") or ""} for rs in found for r in rs]


@app.get("/v2/code/search")
async def code_search(
    query: str,
    k: int = 10,
    types: list[str] | None = Query(None),
    repos: list[str] | None = Query(None),
    sources: list[str] | None = Query(None),
    passages: int = 1,
    language: str | None = None,
    topic: list[str] | None = Query(None),
    license: str | None = None,
    min_stars: int | None = None,
    max_stars: int | None = None,
    archived: bool | None = None,
    fork: bool | None = None,
    skills: str | None = None,
):
    kinds = set(types or ["doc", "issue", "pull_request", "readme"])
    repos, sources, topic = repos or [], sources or [], topic or []
    if repos and not sources:
        kinds.discard("doc")  # a repo filter scopes the search to GitHub
    if sources and not repos:
        kinds &= {"doc"}
    jobs = []
    if kinds & {"issue", "pull_request"} and skills != "only":
        jobs.append(github_threads(query, k, kinds & {"issue", "pull_request"}, repos, language))
    if "readme" in kinds:
        jobs.append(github_readmes(query, k, repos, language, topic, license, min_stars, max_stars,
                                   archived, fork, skills))
    if "doc" in kinds and skills != "only":
        jobs.append(docs(query, k, sources))
        if not sources:
            jobs.append(stackoverflow(query, k, language))
    found = await asyncio.gather(*jobs, return_exceptions=True)
    items, seen = [], set()
    for group in found:
        for item in group if isinstance(group, list) else []:  # a failed backend only drops its results
            if item["url"] not in seen:
                seen.add(item["url"])
                items.append(item)
    order = bm25(query, [f"{i['title']} {i['_text'][:3000]}" for i in items])
    ranked = [i for _, i in sorted(zip(order, items), key=lambda p: -p[0])][:k]
    results = []
    for item in ranked:
        best = best_passages(query, item["_text"], passages, 700) or [(item["title"], 0)]
        results.append({"id": item["id"], "url": item["url"], "title": item["title"],
                        "passages": [{"text": t, "citation_url": item["url"]} for t, _ in best]})
    body = {"success": True, "results": results}
    if repos:  # live GitHub search covers any public repository
        body["repos"] = [{"repo": r, "indexed": True, "types": {"issue": True, "pullRequest": True, "readme": True}}
                         for r in repos]
    if sources:
        body["sources"] = [{"source": s, "indexed": "." in s} for s in sources]
    return body


# ---------- gov ----------

STATES = set(
    "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd "
    "oh ok or pa ri sc sd tn tx ut vt wa wv wi wy as gu mp pr vi".split()
)
FEDERAL_TWO_LETTER = {"va", "ed"}  # va.gov (Veterans Affairs) and ed.gov (Education) are federal
COURT_HOST = re.compile(r"^(?:www\.)?(ca\d+|cadc|cafc|[a-z]{2,3}[dbn]?d|[a-z]{2,3}b)\.uscourts\.gov$")
CITE_ID = re.compile(r"^us:(usc|cfr):(\d+):([\w.\-]+)$", re.I)


def labels(url: str) -> dict:
    host = (urlparse(url).hostname or "").lower()
    parts = host.split(".")
    out: dict = {"lang": "en"}
    state = None
    if m := re.search(r"\.state\.([a-z]{2})\.us$", host):
        state = m.group(1)
    elif host.endswith(".gov") and len(parts) >= 2 and parts[-2] in STATES and parts[-2] not in FEDERAL_TWO_LETTER:
        state = parts[-2]
    if state:
        out["jurisdiction"] = f"us-{state}"
    elif host.endswith(".gov") or host.endswith(".mil") or host.endswith("uscourts.gov"):
        out["jurisdiction"] = "us"
    if host.endswith("supremecourt.gov"):
        out.update(court="scotus", court_type="federal-supreme")
    elif m := COURT_HOST.match(host):
        court = m.group(1)
        out["court"] = court
        out["court_type"] = ("federal-appellate" if re.fullmatch(r"ca\d+|cadc|cafc", court)
                             else "federal-bankruptcy" if court.endswith("b") else "federal-district")
    return out


def printed_cite(cite: str) -> str:
    if m := CITE_ID.match(cite.strip()):
        code, title, section = m.groups()
        return f"{title} {'U.S.C.' if code.lower() == 'usc' else 'CFR'} {section}"
    return cite.strip()


def epoch_ms(day: str | None) -> int | None:
    try:
        return int(datetime.fromisoformat(day[:10]).replace(tzinfo=timezone.utc).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


async def federal_register(query: str, k: int) -> list[dict]:
    params = {"conditions[term]": query, "per_page": min(k, 20), "order": "relevance",
              "fields[]": ["title", "html_url", "abstract", "publication_date", "type"]}
    found = await fetch("https://www.federalregister.gov/api/v1/documents.json", params)
    return [{"url": d["html_url"], "title": d["title"], "description": plain(d.get("abstract")),
             "updated_at": epoch_ms(d.get("publication_date"))} for d in (found or {}).get("results", [])]


async def ecfr(query: str, k: int) -> list[dict]:
    found = await fetch("https://www.ecfr.gov/api/search/v1/results", {"query": query, "per_page": min(k, 20)})
    out = []
    for r in (found or {}).get("results", []):
        h, heads = r.get("hierarchy") or {}, r.get("headings") or {}
        if h.get("section"):
            url = f"https://www.ecfr.gov/current/title-{h['title']}/section-{h['section']}"
            title = f"{h['title']} CFR {h['section']} {plain(heads.get('section'))}"
        elif h.get("part"):
            url = f"https://www.ecfr.gov/current/title-{h['title']}/part-{h['part']}"
            title = f"{h['title']} CFR Part {h['part']} {plain(heads.get('part'))}"
        else:
            continue
        out.append({"url": url, "title": title.strip(), "description": plain(r.get("full_text_excerpt")),
                    "updated_at": epoch_ms(r.get("starts_on"))})
    return out


async def gov_web(query: str, k: int, domain: str | None, jurisdiction: str | None) -> list[dict]:
    site = domain or (f"{jurisdiction[3:]}.gov" if jurisdiction and jurisdiction.startswith("us-") else "gov")
    keep = (lambda h: h == domain or h.endswith("." + domain)) if domain else (
        lambda h: h.endswith(".gov") or h.endswith(".mil") or h.endswith(".us"))
    out = []
    for r in await searxng(f"{query} site:{site}", k * 2):
        if keep((urlparse(r["url"]).hostname or "").lower()):
            out.append({"url": r["url"], "title": r.get("title") or r["url"], "description": r.get("content") or ""})
    return out


@app.post("/api/v1/gov-search")
async def gov_search(request: Request):
    body = await request.json()
    query, k = body.get("query", ""), int(body.get("top_k") or 10)
    jurisdiction, domain = body.get("jurisdiction"), body.get("domain")
    court, court_type = body.get("court"), body.get("court_type")
    cites = body.get("cites") or []
    sources = body.get("sources") or ["web"]
    cites = [cites] if isinstance(cites, str) else cites
    if cites:  # ponytail: no citation graph; the printed citations become search terms
        query += " " + " ".join(f'"{printed_cite(c)}"' for c in cites)
    federal = jurisdiction in (None, "us") and not domain
    jobs = [gov_web(query, k, domain, jurisdiction)]
    if federal and not court and not court_type:
        jobs += [ecfr(query, k), federal_register(query, k)]
    groups = [g if isinstance(g, list) else [] for g in await asyncio.gather(*jobs, return_exceptions=True)]
    # Rank the union by how well title and summary match, plus a small bonus
    # for each source's own order, so a weak regulation hit cannot take a slot
    # from a strong web result just by taking turns.
    merged, seen, prior = [], set(), []
    for g in groups:
        for row, r in enumerate(g):
            if r["url"] not in seen:
                seen.add(r["url"])
                merged.append({**r, **labels(r["url"])})
                prior.append(0.3 / (1 + row))
    match = normalized(bm25(query, [f"{r['title']} {r['description']}" for r in merged]))
    merged = [r for _, r in sorted(zip([m + p for m, p in zip(match, prior)], merged), key=lambda x: -x[0])]
    def wanted(r):
        return ((not jurisdiction or r.get("jurisdiction") == jurisdiction)
                and (not court or r.get("court") == court)
                and (not court_type or r.get("court_type") == court_type))
    merged = [r for r in merged if wanted(r)][:k]
    web, gov = [], []
    for position, r in enumerate(merged, start=1):
        web.append({"url": r["url"], "title": r["title"], "description": r["description"], "position": position})
        gov.append({key: v for key, v in {**web[-1], **r}.items() if v is not None})
    data = {}
    if "web" in sources:
        data["web"] = web
    if "gov" in sources:
        data["gov"] = gov
    return {"success": True, "data": data}
