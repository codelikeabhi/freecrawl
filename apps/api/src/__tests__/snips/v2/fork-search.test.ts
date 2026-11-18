// fork: SearXNG-backed search and map (PLAN.md Phase 3). These paths only run
// when SearXNG is the backend, i.e. self-hosted without Fire-engine.
import { concurrentIf, describeIf } from "../lib";
import {
  expectMapToSucceed,
  idmux,
  Identity,
  map,
  search,
  searchRaw,
} from "./lib";
import { config } from "../../../config";

const FORK_SEARCH = !!config.SEARXNG_ENDPOINT && !config.FIRE_ENGINE_BETA_URL;

const hostOf = (url?: string) => (url ? new URL(url).hostname : "");

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-search",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describeIf(FORK_SEARCH)("Fork: SearXNG search and map", () => {
  it.concurrent(
    "returns news results",
    async () => {
      const res = await search(
        { query: "web scraping", limit: 5, sources: ["news"] },
        identity,
      );
      expect(res.news?.length).toBeGreaterThan(0);
      expect(res.news![0].url).toBeTruthy();
    },
    60000,
  );

  it.concurrent(
    "returns image results with image URLs",
    async () => {
      const res = await search(
        { query: "web scraping", limit: 5, sources: ["images"] },
        identity,
      );
      expect(res.images?.length).toBeGreaterThan(0);
      expect(res.images![0].imageUrl).toMatch(/^https?:\/\//);
    },
    60000,
  );

  it.concurrent(
    "returns web and news groups together",
    async () => {
      const res = await search(
        { query: "open source", limit: 3, sources: ["web", "news"] },
        identity,
      );
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.news?.length).toBeGreaterThan(0);
    },
    60000,
  );

  it.concurrent(
    "accepts a Google-style time filter",
    async () => {
      const res = await search(
        { query: "firecrawl release", limit: 5, tbs: "qdr:m" },
        identity,
      );
      expect(res.web?.length).toBeGreaterThan(0);
    },
    60000,
  );

  concurrentIf(!config.RESEARCH_PROXY_URL)(
    "serves the developer category from SearXNG code engines",
    async () => {
      const res = await search(
        {
          query: "playwright click selector timeout",
          limit: 5,
          categories: ["developer"],
        },
        identity,
      );
      expect(res.web?.length).toBeGreaterThan(0);
      expect(res.web!.every(r => r.category === "developer")).toBe(true);
    },
    60000,
  );

  // ponytail: the gov fallback needs an engine that honors `site:gov` (today
  // only google cse, which rate-limits), so this checks our guarantees, not
  // engine health: only .gov hosts, and never a silent empty answer. Phase 3b
  // replaces it with free government APIs.
  concurrentIf(!config.SEARCH_PLATFORM_URL)(
    "serves the gov category with .gov hosts only, or warns",
    async () => {
      const raw = await searchRaw(
        { query: "broadband grants", limit: 5, categories: ["gov"] },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      const web: { url: string }[] = raw.body.data.web ?? [];
      expect(web.every(r => hostOf(r.url).endsWith(".gov"))).toBe(true);
      if (web.length === 0) {
        expect(raw.body.warning).toMatch(/No search results/);
      }
    },
    60000,
  );

  it.concurrent(
    "enforces includeDomains on returned URLs",
    async () => {
      const res = await search(
        { query: "mvcc", limit: 5, includeDomains: ["postgresql.org"] },
        identity,
      );
      expect(res.web?.length).toBeGreaterThan(0);
      expect(
        res.web!.every(r => hostOf(r.url).endsWith("postgresql.org")),
      ).toBe(true);
    },
    60000,
  );

  it.concurrent(
    "maps a site that has no sitemap, staying on that site",
    async () => {
      const res = await map(
        { url: "https://books.toscrape.com/", limit: 20, ignoreCache: true },
        identity,
      );
      expectMapToSucceed(res);
      expect(
        res.body.links.every((l: { url: string }) =>
          hostOf(l.url).endsWith("books.toscrape.com"),
        ),
      ).toBe(true);
    },
    120000,
  );

  it.concurrent(
    "warns instead of silently succeeding when nothing is found",
    async () => {
      const raw = await searchRaw(
        {
          query: "firecrawl",
          limit: 5,
          includeDomains: ["no-such-site-for-fork-tests.invalid"],
        },
        identity,
      );
      expect(raw.statusCode).toBe(200);
      expect(raw.body.data.web ?? []).toHaveLength(0);
      expect(raw.body.warning).toMatch(/No search results/);
    },
    60000,
  );
});
