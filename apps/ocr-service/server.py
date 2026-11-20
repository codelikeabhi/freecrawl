"""fork: FirePDF-compatible OCR service backed by MinerU (PLAN.md Phase 8, D6).

The API's FirePDF client (apps/api/src/scraper/scrapeURL/engines/pdf/firePDF.ts)
POSTs {pdf: base64, mode?, max_pages?, include_page_markdown?, page_markers?,
timeout?, created_at?} to /ocr and reads {markdown, failed_pages, pages?,
pages_processed?, page_markers?}. The image engine sends image bytes in the
same `pdf` field. Typed `blocks` are not produced: a caller that asks for them
falls back to the API's other PDF parsers.

MinerU conversion adapted from firecrawl/mineru-api (app/serverless.py,
AGPL-3.0, same license as this fork). Runs on the host so MinerU can use the
Apple GPU (MPS); bound to 127.0.0.1. Start with scripts/fork/ocr.sh.
"""

import asyncio
import base64
import io
import os
import re
import tempfile
import time

import torch

# MinerU picks its device from this variable; set it before importing MinerU.
os.environ.setdefault(
    "MINERU_DEVICE_MODE", "mps" if torch.backends.mps.is_available() else "cpu"
)
# MinerU's formula detector is Ultralytics YOLO, which by default sends usage
# analytics on every prediction and pip-installs missing packages at runtime.
# Keep it offline, and keep its settings file next to this service.
os.environ.setdefault("YOLO_OFFLINE", "true")
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault(
    "YOLO_CONFIG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ultralytics")
)
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# Models come from the folder `mineru-models-download` recorded in
# ~/mineru.json (scripts/fork/ocr.sh), with no Hugging Face call per request.
os.environ.setdefault("MINERU_MODEL_SOURCE", "local")

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from mineru.backend.pipeline.model_json_to_middle_json import (  # noqa: E402
    result_to_middle_json,
)
from mineru.backend.pipeline.pipeline_analyze import doc_analyze  # noqa: E402
from mineru.backend.pipeline.pipeline_middle_json_mkcontent import (  # noqa: E402
    union_make,
)
from mineru.data.data_reader_writer import FileBasedDataWriter  # noqa: E402
from mineru.utils.enum_class import MakeMode  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402

app = FastAPI()
# MinerU is heavy and holds models in memory: one document at a time.
busy = asyncio.Lock()

# FirePDF modes -> MinerU parse methods. `fast` = text layer only.
PARSE_METHOD = {"fast": "txt", "auto": "auto", "ocr": "ocr"}
DEAD_IMAGE = re.compile(r"!\[[^\]]*\]\(images/[^)]*\)")


class OcrRequest(BaseModel):
    pdf: str
    mode: str | None = None
    max_pages: int | None = None
    include_page_markdown: bool = False
    include_blocks: bool = False
    page_markers: bool = False
    timeout: int | None = None  # ms of budget left when the API sent it
    created_at: int | None = None  # epoch ms when the API sent it


def as_pdf(data: bytes) -> tuple[bytes, bool]:
    """(PDF bytes, was it an image). An image becomes a one-page PDF."""
    if data[:5] == b"%PDF-":
        return data, False
    try:
        # Upright like MinerU's own image path (phone photos carry EXIF rotation).
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        # ponytail: fixed 2x for small images (screenshots, crops); compression
        # noise made MinerU misread "l" as "I" at 1x. Tune if big photos suffer.
        if image.width < 1500:
            image = image.resize((image.width * 2, image.height * 2), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, "PDF")
        return out.getvalue(), True
    except Exception as error:
        raise ValueError(f"invalid or corrupt input: {error}") from error


def first_pages(pdf: bytes, max_pages: int | None) -> tuple[bytes, int]:
    try:
        reader = PdfReader(io.BytesIO(pdf))
        total = len(reader.pages)
    except Exception as error:
        raise ValueError(f"invalid or corrupt PDF: {error}") from error
    if not max_pages or max_pages >= total:
        return pdf, total
    writer = PdfWriter()
    for i in range(max_pages):
        writer.add_page(reader.pages[i])
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), max_pages


def convert(pdf: bytes, parse_method: str, formulas: bool) -> list[str]:
    """Markdown per page."""
    results, images, docs, langs, ocr_flags = doc_analyze(
        [pdf], ["en"], parse_method=parse_method, formula_enable=formulas, table_enable=True
    )
    with tempfile.TemporaryDirectory() as tmp:
        middle = result_to_middle_json(
            results[0], images[0], docs[0], FileBasedDataWriter(tmp),
            langs[0], ocr_flags[0], formulas,
        )
        # MinerU links figure crops it saved in `tmp`, which is gone once we
        # return; drop the dead links (captions are separate text and stay).
        return [
            DEAD_IMAGE.sub("", union_make([page], MakeMode.MM_MD, "images")).strip()
            for page in middle["pdf_info"]
        ]


@app.get("/health")
def health():
    return {"status": "healthy", "device": os.environ["MINERU_DEVICE_MODE"]}


@app.post("/ocr")
async def ocr(req: OcrRequest):
    # Honor the API's deadline: give up early instead of finishing late.
    remaining = None
    if req.timeout and req.created_at:
        remaining = req.timeout / 1000 - (time.time() - req.created_at / 1000)
        if remaining <= 1:
            return JSONResponse({"error": "deadline exceeded"}, status_code=503)
    try:
        pdf, is_image = as_pdf(base64.b64decode(req.pdf))
        pdf, pages_processed = first_pages(pdf, req.max_pages)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)

    method = PARSE_METHOD.get(req.mode or "auto", "auto")
    async with busy:
        try:
            # Formula detection stays on for documents (papers have equations);
            # on photos and screenshots it mistook compression noise for one.
            pages = await asyncio.wait_for(
                asyncio.to_thread(convert, pdf, method, not is_image), timeout=remaining
            )
        except asyncio.TimeoutError:
            return JSONResponse({"error": "deadline exceeded"}, status_code=503)

    separator = "\n\n---\n\n<!-- page {} -->\n\n" if req.page_markers else "\n\n"
    markdown = pages[0] if pages else ""
    for number, text in enumerate(pages[1:], start=2):
        markdown += separator.format(number) + text
    body = {
        "markdown": markdown,
        "failed_pages": [],
        "partial_pages": [],
        "pages_processed": pages_processed,
    }
    if req.include_page_markdown:
        body["pages"] = [{"page": i + 1, "markdown": text} for i, text in enumerate(pages)]
    if req.page_markers:
        body["page_markers"] = True
    return body
