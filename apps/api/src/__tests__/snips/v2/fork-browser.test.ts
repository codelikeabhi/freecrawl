// fork: browser features on the Playwright engine without Fire-engine
// (PLAN.md Phase 5): actions, screenshots, PDFs, device and locale emulation,
// blockAds, rawBase64, and screenshots stored as files.
import {
  describeIf,
  HAS_FIRE_ENGINE,
  HAS_PLAYWRIGHT,
  scrapeTimeout,
} from "../lib";
import { crawl, idmux, Identity, scrape, scrapeRaw } from "./lib";

const FORK_BROWSER = HAS_PLAYWRIGHT && !HAS_FIRE_ENGINE;
const PDF_URL =
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

// Stored files are served at http://localhost:3010 for the host; this runner
// sits on the compose network, where the same container is http://files.
async function readStored(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  }
  const res = await fetch(
    url.replace(/^http:\/\/localhost:3010/, "http://files"),
  );
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}
const isPng = (b: Buffer) => b.subarray(0, 4).toString("hex") === "89504e47";
const isJpeg = (b: Buffer) => b.subarray(0, 3).toString("hex") === "ffd8ff";
const isPdf = (b: Buffer) => b.subarray(0, 4).toString() === "%PDF";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-browser",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

describeIf(FORK_BROWSER)("Fork: browser features on Playwright", () => {
  it.concurrent(
    "logs in with click, write and press, then screenshots and scrapes",
    async () => {
      const doc = await scrape(
        {
          url: "https://quotes.toscrape.com/login",
          formats: ["markdown"],
          actions: [
            { type: "click", selector: "#username" },
            { type: "write", text: "fork" },
            { type: "click", selector: "#password" },
            { type: "write", text: "test" },
            { type: "press", key: "Enter" },
            { type: "wait", selector: "a[href='/logout']" },
            { type: "screenshot" },
            { type: "scrape" },
          ],
        },
        identity,
      );
      expect(doc.markdown).toMatch(/Logout/);
      expect(doc.actions?.scrapes?.[0]?.html).toContain("/logout");
      expect(isPng(await readStored(doc.actions!.screenshots![0]))).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "stores a full-page PNG and a JPEG when quality is set, with host paths",
    async () => {
      const full = await scrape(
        {
          url: "https://example.com",
          formats: [{ type: "screenshot", fullPage: true }],
        },
        identity,
      );
      expect(isPng(await readStored(full.screenshot!))).toBe(true);
      if (!full.screenshot!.startsWith("data:")) {
        expect(full.metadata.localFiles?.[0]).toMatch(
          /\/data\/files\/.+\.png$/,
        );
      }

      const jpeg = await scrape(
        {
          url: "https://example.com",
          formats: [{ type: "screenshot", quality: 50 }],
        },
        identity,
      );
      expect(isJpeg(await readStored(jpeg.screenshot!))).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "prints the page with a pdf action",
    async () => {
      const doc = await scrape(
        {
          url: "https://example.com",
          actions: [{ type: "pdf", format: "A4" }],
        },
        identity,
      );
      expect(isPdf(await readStored(doc.actions!.pdfs![0]))).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "emulates a phone",
    async () => {
      const doc = await scrape(
        {
          url: "https://example.com",
          mobile: true,
          actions: [
            {
              type: "executeJavascript",
              script: "return [navigator.userAgent, innerWidth]",
            },
          ],
        },
        identity,
      );
      const [ua, width] = doc.actions!.javascriptReturns![0].value as [
        string,
        number,
      ];
      expect(ua).toMatch(/iPhone/);
      expect(width).toBeLessThan(500);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "sets the browser language for location and says the IP is unchanged",
    async () => {
      const doc = await scrape(
        {
          url: "https://example.com",
          location: { country: "DE", languages: ["de-DE"] },
          actions: [
            { type: "executeJavascript", script: "return navigator.language" },
          ],
        },
        identity,
      );
      expect(doc.actions!.javascriptReturns![0].value).toBe("de-DE");
      expect(doc.warning).toMatch(/IP address/);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "scrapes with ad blocking turned off",
    async () => {
      const doc = await scrape(
        { url: "https://example.com", blockAds: false },
        identity,
      );
      expect(doc.markdown?.length ?? 0).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "returns the original bytes for rawBase64",
    async () => {
      const doc = await scrape(
        { url: PDF_URL, formats: ["rawBase64"] },
        identity,
      );
      expect(isPdf(Buffer.from(doc.rawBase64!, "base64"))).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "crawls with screenshots",
    async () => {
      const res = await crawl(
        {
          url: "https://books.toscrape.com/",
          limit: 2,
          scrapeOptions: { formats: ["screenshot"] },
        },
        identity,
      );
      expect(res.status).toBe("completed");
      expect(res.data.length).toBeGreaterThan(0);
      expect(res.data[0].screenshot).toBeTruthy();
    },
    scrapeTimeout * 2,
  );

  // Failure path: a missing selector names the step and leaves no page open.
  it(
    "fails a missing selector with the step's name and frees the browser",
    async () => {
      const started = Date.now();
      const raw = await scrapeRaw(
        {
          url: "https://example.com",
          actions: [{ type: "click", selector: "#nope" }],
        },
        identity,
      );
      expect(raw.statusCode).toBe(500);
      expect(raw.body.code).toBe("SCRAPE_ACTION_ERROR");
      expect(raw.body.error).toMatch(/action 0 \(click\)/);
      expect(Date.now() - started).toBeLessThan(30000);

      const health = await (
        await fetch("http://playwright-service:3000/health")
      ).json();
      expect(health.activePages).toBe(0);
    },
    scrapeTimeout,
  );
});
