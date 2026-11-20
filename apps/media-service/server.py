"""fork: media service speaking avgrab's contract (PLAN.md Phase 9, G9).

The API's avgrab client (AVGRAB_SERVICE_URL; transformers/audio.ts, video.ts,
postprocessors/youtube.ts, lib/avgrab-resolve.ts) calls:
  GET  /supported-urls   {regex, resolve_regex}      JS-syntax regexes
  POST /download         {url, cookies?} -> {public_url}   audio file
  POST /download-video   {url, cookies?} -> {public_url}   video file
  POST /videos           {url, html?}    -> {videos: VideoItem[]}
  POST /metadata         {url, transcript_language, cookies?} -> YouTube metadata + transcript
  POST /resolve          not offered: resolve_regex matches nothing
Errors are {"detail": "..."}, which the API turns into "... failed: <detail>".

Built on yt-dlp (+ Deno for YouTube, ffmpeg for merging). Files go flat into
the shared files folder, served at FILES_URL and deleted after 24 h by the
API's cleanup (lib/fork-files.ts). Only for media the owner may download.
"""

import asyncio
import html as htmlmod
import os
import re
import secrets
from urllib.parse import urljoin

import json
import yt_dlp
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

FILES_DIR = os.environ.get("FILES_DIR", "/data/files")
FILES_URL = os.environ.get("FILES_URL", "http://localhost:3010").rstrip("/")
MAX_BYTES = 500 * 1024 * 1024

# Sites we offer (yt-dlp knows many more; keep the list deliberate).
SUPPORTED = (
    r"^https?://(?:[\w-]+\.)*(?:"
    r"youtube\.com/(?:watch|shorts/|live/|embed/)|youtu\.be/|music\.youtube\.com/watch|"
    r"vimeo\.com/\d|player\.vimeo\.com/video/|soundcloud\.com/[^/]+/[^/]+|"
    r"dailymotion\.com/video/|twitch\.tv/(?:videos/|[^/]+/clip/)|clips\.twitch\.tv/|"
    r"tiktok\.com/@[^/]+/video/|(?:x|twitter)\.com/[^/]+/status/|"
    r"bandcamp\.com/track/|ted\.com/talks/|archive\.org/details/)"
)

app = FastAPI()
supported = re.compile(SUPPORTED)
# One download at a time: they are large and share the home connection.
download_slot = asyncio.Semaphore(1)


def fail(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


def ydl_options(**extra) -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "max_filesize": MAX_BYTES,
        **extra,
    }


def download(url: str, fmt: str, extra: dict) -> str:
    name = secrets.token_hex(16)
    opts = ydl_options(format=fmt, outtmpl=os.path.join(FILES_DIR, f"{name}.%(ext)s"), **extra)
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(url, download=True)
    # The final name after merging or extracting audio.
    files = [f for f in os.listdir(FILES_DIR) if f.startswith(name + ".")]
    if not files:
        raise yt_dlp.utils.DownloadError("download produced no file (too large or unavailable?)")
    return f"{FILES_URL}/{files[0]}"


async def media(request: Request, attempts: list[tuple[str, dict]]):
    body = await request.json()
    url = body.get("url", "")
    if not supported.search(url):
        return fail(400, "URL is not supported by the local media service")
    error = None
    async with download_slot:
        for fmt, extra in attempts:
            try:
                return {"public_url": await asyncio.to_thread(download, url, fmt, extra)}
            except yt_dlp.utils.DownloadError as e:
                error = e
    return fail(422, str(error).removeprefix("ERROR: ")[:500])


@app.get("/health")
def health():
    return {"status": "healthy", "yt_dlp": yt_dlp.version.__version__}


@app.get("/supported-urls")
def supported_urls():
    return {"regex": SUPPORTED, "resolve_regex": "(?!)"}


@app.post("/download")
async def download_audio(request: Request):
    # The source's own audio stream, no re-encoding. YouTube sometimes refuses
    # audio-only streams (403) while serving the combined one; then take that
    # and extract the audio.
    extract = {"postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}]}
    return await media(request, [("bestaudio[ext=m4a]/bestaudio", {}), ("18/b", extract)])


@app.post("/download-video")
async def download_video(request: Request):
    # ponytail: 720p cap keeps files and time sane; raise it if wanted.
    fmt = "best[ext=mp4][height<=720]/bv*[height<=720]+ba/b[height<=720]/b"
    return await media(request, [(fmt, {"merge_output_format": "mp4"}), ("18/b", {})])


VIDEO_TAG = re.compile(r"<video\b[^>]*>.*?</video>|<video\b[^>]*/?>", re.I | re.S)
SRC = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.I)
TYPE = re.compile(r"""\btype\s*=\s*["']([^"']+)["']""", re.I)
OG_VIDEO = re.compile(
    r"""<meta[^>]+(?:property|name)\s*=\s*["']og:video(?::secure_url|:url)?["'][^>]*>""", re.I
)
CONTENT = re.compile(r"""\bcontent\s*=\s*["']([^"']+)["']""", re.I)


@app.post("/videos")
async def videos(request: Request):
    """Video files linked from a page's HTML (<video>, <source>, og:video)."""
    body = await request.json()
    page, html = body.get("url", ""), body.get("html") or ""
    found: dict[str, dict] = {}
    for block in VIDEO_TAG.findall(html):
        for tag in re.findall(r"<(?:video|source)\b[^>]*>", block, re.I):
            src = SRC.search(tag)
            if src and not src.group(1).startswith(("blob:", "data:")):
                url = urljoin(page, htmlmod.unescape(src.group(1)))
                kind = TYPE.search(tag)
                found.setdefault(url, {"url": url, "sourceURL": page, "source": "html", "kind": "file",
                                       **({"mimeType": kind.group(1)} if kind else {})})
    for tag in OG_VIDEO.findall(html):
        content = CONTENT.search(tag)
        if content:
            url = urljoin(page, htmlmod.unescape(content.group(1)))
            found.setdefault(url, {"url": url, "sourceURL": page, "source": "og:video", "kind": "file"})
    return {"videos": list(found.values())}


def transcript(ydl: yt_dlp.YoutubeDL, info: dict, language: str) -> str | None:
    """Plain text of the manual subtitles in `language`, else auto captions."""
    for tracks in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        key = language if language in tracks else next((k for k in tracks if k.split("-")[0] == language), None)
        if not key:
            continue
        json3 = next((t["url"] for t in tracks[key] if t.get("ext") == "json3"), None)
        if not json3:
            continue
        events = json.loads(ydl.urlopen(json3).read()).get("events", [])
        lines = ["".join(seg.get("utf8", "") for seg in e.get("segs", [])).strip() for e in events]
        text = "\n".join(line for line in lines if line)
        if text:
            return text
    return None


def length(seconds) -> str | None:
    """1:02:03 / 4:05 / 0:19."""
    if not isinstance(seconds, (int, float)):
        return None
    h, rest = divmod(int(seconds), 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def youtube_metadata(url: str, language: str) -> dict:
    with yt_dlp.YoutubeDL(ydl_options(skip_download=True)) as ydl:
        info = ydl.extract_info(url, download=False)
        text = transcript(ydl, info, language)
    thumbs = sorted(info.get("thumbnails") or [], key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
    best = thumbs[-1] if thumbs else {"url": info.get("thumbnail")}
    day = info.get("upload_date")
    return {
        "thumbnail_image": {"url": best.get("url") or info.get("thumbnail") or "",
                            "width": best.get("width"), "height": best.get("height")},
        "title": info.get("title") or "",
        "visibility": info.get("availability"),
        "uploaded_by": {"name": info.get("channel") or info.get("uploader"),
                        "url": info.get("channel_url") or info.get("uploader_url")},
        "uploaded_at": f"{day[:4]}-{day[4:6]}-{day[6:]}" if day else None,
        # YouTube's upload date is its publish date; yt-dlp has no other.
        "published_at": f"{day[:4]}-{day[4:6]}-{day[6:]}" if day else None,
        "length": length(info.get("duration")),
        "views": info.get("view_count"),
        "likes": info.get("like_count"),
        "category": (info.get("categories") or [None])[0],
        "description": info.get("description"),
        "transcript": text,
    }


@app.post("/metadata")
async def metadata(request: Request):
    body = await request.json()
    try:
        return await asyncio.to_thread(youtube_metadata, body.get("url", ""), body.get("transcript_language") or "en")
    except yt_dlp.utils.DownloadError as error:
        return fail(422, str(error).removeprefix("ERROR: ")[:500])
