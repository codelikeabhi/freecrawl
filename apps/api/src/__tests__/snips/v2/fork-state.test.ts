// fork: local state (PLAN.md Phase 10, D10). Scrape index in Postgres,
// documents in fake-gcs, job access/state and change-tracking history in
// Redis. Upstream's cache and lockdown snips only run against production.
import crypto from "crypto";
import { describeIf } from "../lib";
import { config } from "../../../config";
import {
  idmux,
  Identity,
  scrape,
  scrapeRaw,
  scrapeStatus,
  scrapeStatusRaw,
  scrapeTimeout,
} from "./lib";

const FORK_STATE =
  process.env.FORK_LOCAL_STATE === "true" &&
  !!config.INDEX_DATABASE_URL &&
  !!config.GCS_BUCKET_NAME;

// quotes.toscrape.com ignores the query string; a fresh one is a fresh URL.
const freshUrl = () =>
  `https://quotes.toscrape.com/tag/love/?t=${crypto.randomUUID()}`;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-state",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(FORK_STATE)("Fork: local state", () => {
  it(
    "serves a repeat scrape from the cache, also in lockdown, and by id",
    async () => {
      const url = freshUrl();
      const first = await scrape({ url, formats: ["markdown"] }, identity);
      expect(first.metadata.cacheState).not.toBe("hit");

      // The index row lands within a few seconds (queue-worker drain loop).
      let cached;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        cached = await scrape(
          { url, formats: ["markdown"], maxAge: 3600000 },
          identity,
        );
        if (cached.metadata.cacheState === "hit") break;
      }
      expect(cached!.metadata.cacheState).toBe("hit");
      expect(cached!.markdown).toBe(first.markdown);

      const locked = await scrape(
        { url, formats: ["markdown"], lockdown: true },
        identity,
      );
      expect(locked.metadata.cacheState).toBe("hit");

      const byId = await scrapeStatus(first.metadata.scrapeId!, identity);
      expect(byId.markdown).toBe(first.markdown);
    },
    scrapeTimeout * 4,
  );

  it(
    "refuses lockdown for a page never scraped, and 404s an unknown id",
    async () => {
      const failure = await scrapeRaw(
        { url: freshUrl(), formats: ["markdown"], lockdown: true },
        identity,
      );
      expect(failure.body.success).toBe(false);
      expect(failure.body.code).toBe("SCRAPE_LOCKDOWN_CACHE_MISS");

      const missing = await scrapeStatusRaw(
        "01a1fad3-0000-7000-8000-000000000000",
        identity,
      );
      expect(missing.statusCode).toBe(404);
    },
    scrapeTimeout,
  );

  it(
    "tracks changes between scrapes of the same page",
    async () => {
      const url = freshUrl();
      const formats = [
        "markdown" as const,
        { type: "changeTracking" as const, modes: ["git-diff" as const] },
      ];
      const first = await scrapeRaw({ url, formats }, identity);
      expect(first.body.data.changeTracking.changeStatus).toBe("new");
      const second = await scrapeRaw({ url, formats }, identity);
      expect(second.body.data.changeTracking.changeStatus).toBe("same");
      expect(second.body.data.changeTracking.previousScrapeAt).toBeDefined();
    },
    scrapeTimeout * 2,
  );
});
