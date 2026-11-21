// fork: stealth engine (PLAN.md Phase 6): Patchright + installed Chrome on the
// host, reached through FORK_STEALTH_URL. Start it with scripts/fork/stealth.sh.
import { describeIf, scrapeTimeout } from "../lib";
import { idmux, Identity, scrape, scrapeRaw } from "./lib";
import { getRedisConnection } from "../../../services/queue-service";

const FORK_STEALTH = !!process.env.FORK_STEALTH_URL;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-stealth",
    concurrency: 10,
    credits: 1000000,
  });
}, 10000);

describeIf(FORK_STEALTH)("Fork: stealth engine", () => {
  it(
    "serves proxy: stealth from real Chrome",
    async () => {
      const doc = await scrape(
        {
          url: "https://example.com",
          proxy: "stealth",
          actions: [
            { type: "executeJavascript", script: "return navigator.webdriver" },
          ],
        },
        identity,
      );
      expect(doc.metadata.proxyUsed).toBe("stealth");
      expect(doc.actions!.javascriptReturns![0].value).toBe(false);
    },
    scrapeTimeout,
  );

  it(
    "escalates a blocked page to stealth, reports the block, and stops",
    async () => {
      const started = Date.now();
      const doc = await scrape(
        { url: "https://httpbin.org/status/403" },
        identity,
      );
      expect(doc.metadata.statusCode).toBe(403);
      expect(doc.metadata.proxyUsed).toBe("stealth");
      expect(doc.metadata.blocked).toBe(true);
      expect(doc.metadata.blockedReason).toBe("HTTP 403");
      expect(Date.now() - started).toBeLessThan(60000);
    },
    scrapeTimeout,
  );

  it(
    "keeps cookies in a named profile between scrapes",
    async () => {
      const value = `v${Date.now()}`;
      await scrape(
        {
          url: "https://example.com",
          profile: { name: "fork-test" },
          actions: [
            {
              type: "executeJavascript",
              script: `document.cookie = "fork_test=${value}; max-age=3600; path=/"; return document.cookie`,
            },
          ],
        },
        identity,
      );
      const second = await scrape(
        {
          url: "https://example.com",
          profile: { name: "fork-test" },
          actions: [
            { type: "executeJavascript", script: "return document.cookie" },
          ],
        },
        identity,
      );
      expect(String(second.actions!.javascriptReturns![0].value)).toContain(
        `fork_test=${value}`,
      );
      // A profile runs on stealth by itself: the host must not be remembered
      // as needing stealth (lib/fork-fetch-first.ts).
      expect(
        await getRedisConnection().get("fork-engine:example.com"),
      ).not.toBe("stealth");
    },
    scrapeTimeout * 2,
  );

  // Failure path: a profile name must not reach the file system as a path.
  it(
    "refuses a profile name that is a path",
    async () => {
      const raw = await scrapeRaw(
        { url: "https://example.com", profile: { name: "../escape" } },
        identity,
      );
      expect(raw.statusCode).not.toBe(200);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
