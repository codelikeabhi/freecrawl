// fork: audio, video and YouTube metadata/transcripts from our yt-dlp
// service behind avgrab's contract (PLAN.md Phase 9). Upstream's media
// snips need fire-engine and expect signed https GCS URLs.
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, scrape, scrapeRaw, scrapeTimeout } from "./lib";

// "Me at the zoo", 19 s: small, public, long-lived, with captions.
const VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-media",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(!!config.AVGRAB_SERVICE_URL)("Fork: media service", () => {
  it(
    "turns a YouTube page into metadata and a transcript",
    async () => {
      const doc = await scrape({ url: VIDEO, maxAge: 0 }, identity);
      expect(doc.markdown).toContain("Me at the zoo");
      expect(doc.markdown).toContain("## Transcript");
      expect(doc.markdown).toMatch(/elephants/i);
      expect(doc.metadata.postprocessorsUsed).toContain("youtube");
    },
    scrapeTimeout * 2,
  );

  it(
    "returns audio and video files",
    async () => {
      const doc = await scrape(
        { url: VIDEO, formats: ["audio", "video"], maxAge: 0 },
        identity,
      );
      expect(doc.audio).toMatch(/^http:\/\/localhost:3010\/[0-9a-f]+\.m4a$/);
      expect(doc.video).toMatch(/^http:\/\/localhost:3010\/[0-9a-f]+\.mp4$/);
    },
    scrapeTimeout * 4,
  );

  it(
    "refuses audio for a site the service does not offer",
    async () => {
      const res = await scrapeRaw(
        { url: "https://example.com", formats: ["audio"] },
        identity,
      );
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("SCRAPE_AUDIO_UNSUPPORTED_URL");
    },
    scrapeTimeout,
  );
});
