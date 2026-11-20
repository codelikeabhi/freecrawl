"""fork: PII redaction speaking fire-privacy's contract (PLAN.md Phase 11, D7).

The API's client (apps/api/src/lib/fire-privacy-client.ts, FIRE_PRIVACY_URL)
POSTs /redact {text, mode, operator, language} per markdown chunk and reads
{redacted_text, spans: [{start, end, kind, source, score}], model_status}.

Backed by Microsoft Presidio (rules + spaCy NER), English only:
  mode heuristics (redactPII fast)       pattern recognizers only
  mode model      (redactPII accurate)   patterns + names and places (NER)
  mode both       (redactPII aggressive) the same, lower score threshold
operator replace -> <KIND>, mask -> ****, redact -> removed.
URLs and dates are left alone: redacting them would break markdown links.
"""

import re

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_analyzer.nlp_engine import NlpEngineProvider
from pydantic import BaseModel

NER = {"PERSON", "LOCATION"}
PATTERNS = {
    "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IBAN_CODE", "US_BANK_NUMBER",
    "US_SSN", "US_ITIN", "CRYPTO", "US_DRIVER_LICENSE", "US_PASSPORT",
    "MEDICAL_LICENSE", "API_KEY",
}
# 0.4: libphonenumber-validated numbers score 0.4 without a nearby "phone".
THRESHOLD = {"heuristics": 0.4, "model": 0.4, "both": 0.3}

# Common secret formats Presidio has no recognizer for.
api_keys = PatternRecognizer(
    supported_entity="API_KEY",
    patterns=[
        Pattern("openai", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b", 0.9),
        Pattern("anthropic", r"\bsk-ant-[A-Za-z0-9_-]{20,}\b", 0.9),
        # Markdown escapes underscores ("ghp\_..."), so accept "\_" too.
        Pattern("github", r"\b(?:ghp|gho|ghs|ghu|github\\?_pat)\\?_[A-Za-z0-9_\\]{20,}", 0.9),
        Pattern("aws", r"\bAKIA[0-9A-Z]{16}\b", 0.9),
        Pattern("slack", r"\bxox[abpr]-[A-Za-z0-9-]{10,}\b", 0.9),
        Pattern("google", r"\bAIza[0-9A-Za-z_-]{35}\b", 0.9),
    ],
)

nlp = NlpEngineProvider(nlp_configuration={
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_md"}],
}).create_engine()
analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
analyzer.registry.add_recognizer(api_keys)

app = FastAPI()


class RedactRequest(BaseModel):
    text: str
    mode: str = "model"
    operator: str = "replace"
    language: str = "en"


@app.get("/health")
def health():
    return {"status": "healthy"}


# Link targets and bare URLs: a span touching one would break the link
# (NER once tagged "docs](https://example.com" as a person).
URLISH = re.compile(r"\]\([^)\s]*\)|<?https?://[^\s)>\]]+")


def outside_urls(text: str, spans: list[dict]) -> list[dict]:
    blocked = [(m.start(), m.end()) for m in URLISH.finditer(text)]
    return [s for s in spans if not any(s["start"] < b and s["end"] > a for a, b in blocked)]


def render(text: str, spans: list[dict], operator: str) -> str:
    out, cursor = [], 0
    for span in spans:
        if span["start"] < cursor:
            continue  # overlaps the previous span
        out.append(text[cursor:span["start"]])
        if operator == "mask":
            out.append("*" * (span["end"] - span["start"]))
        elif operator == "replace":
            out.append(f"<{span['kind']}>")
        cursor = span["end"]
    out.append(text[cursor:])
    return "".join(out)


@app.post("/redact")
def redact(req: RedactRequest):
    if req.language != "en":
        return JSONResponse({"detail": "only English is supported"}, status_code=400)
    if not req.text.strip():
        return {"redacted_text": req.text, "spans": [], "model_status": "skipped"}
    entities = sorted(PATTERNS | (NER if req.mode in ("model", "both") else set()))
    results = analyzer.analyze(
        text=req.text, language="en", entities=entities,
        score_threshold=THRESHOLD.get(req.mode, 0.5),
    )
    # Longest, most confident span first where two overlap.
    results.sort(key=lambda r: (r.start, -(r.end - r.start), -r.score))
    spans = [
        {"start": r.start, "end": r.end, "kind": r.entity_type, "score": round(r.score, 3),
         "source": (r.recognition_metadata or {}).get("recognizer_name", "PresidioRecognizer")}
        for r in results
    ]
    spans = outside_urls(req.text, spans)
    return {"redacted_text": render(req.text, spans, req.operator), "spans": spans, "model_status": "ok"}
