// fork: plain fetch first, browser only when needed, verdicts per host in
// Redis (scraper/scrapeURL/lib/fork-fetch-first.ts, BEYOND item 5).
import {
  describeIf,
  HAS_FIRE_ENGINE,
  HAS_PLAYWRIGHT,
  scrapeTimeout,
} from "../lib";
import { idmux, Identity, scrape } from "./lib";
import { getRedisConnection } from "../../../services/queue-service";
import { buildFallbackList } from "../../../scraper/scrapeURL/engines";

const FETCH_FIRST =
  process.env.FORK_FETCH_FIRST === "true" && HAS_PLAYWRIGHT && !HAS_FIRE_ENGINE;
const verdict = (host: string) =>
  getRedisConnection().get(`fork-engine:${host}`);

let identity: Identity;

describeIf(FETCH_FIRST)("Fork: fetch first", () => {
  beforeAll(async () => {
    identity = await idmux({ name: "fork-fetch-first", credits: 1000000 });
    await getRedisConnection().del(
      "fork-engine:quotes.toscrape.com",
      "fork-engine:books.toscrape.com",
    );
  }, 10000);

  it(
    "keeps a static page from plain fetch",
    async () => {
      const doc = await scrape(
        { url: "https://books.toscrape.com/", maxAge: 0 },
        identity,
      );
      expect(doc.markdown).toContain("A Light in the");
      expect(await verdict("books.toscrape.com")).toBeNull();
    },
    scrapeTimeout,
  );

  it(
    "caches a page that plain fetch served, for maxAge and lockdown",
    async () => {
      // A new query string: a page the cache has not seen, on a fetch host.
      const url = `https://books.toscrape.com/?t=${crypto.randomUUID()}`;
      const first = await scrape({ url }, identity);
      expect(await verdict("books.toscrape.com")).toBeNull();
      let cached;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        cached = await scrape({ url, maxAge: 3600000 }, identity);
        if (cached.metadata.cacheState === "hit") break;
      }
      expect(cached!.metadata.cacheState).toBe("hit");
      const locked = await scrape({ url, lockdown: true }, identity);
      expect(locked.markdown).toBe(first.markdown);
    },
    scrapeTimeout * 3,
  );

  it(
    "renders a JavaScript-only page in the browser and remembers the host",
    async () => {
      // The quotes on /js/ exist only after its script runs.
      const doc = await scrape(
        { url: "https://quotes.toscrape.com/js/", maxAge: 0 },
        identity,
      );
      expect(doc.markdown).toContain("Albert Einstein");
      expect(await verdict("quotes.toscrape.com")).toBe("browser");
    },
    scrapeTimeout,
  );

  it("orders engines by the host's verdict and the request's features", async () => {
    const meta = (url: string, flags: string[] = []) =>
      ({
        id: "test",
        url,
        options: { formats: [], maxAge: 0, proxy: "auto" },
        internalOptions: { teamId: "test" },
        featureFlags: new Set(flags),
        mock: null,
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
          child() {
            return this;
          },
        },
      }) as any;
    const order = async (url: string, flags?: string[]) =>
      (await buildFallbackList(meta(url, flags))).map(f => f.engine);
    // a comes before b, or b is not in the list at all
    const before = (list: string[], a: string, b: string) =>
      list.includes(a) &&
      (!list.includes(b) || list.indexOf(a) < list.indexOf(b));

    const fresh = `https://fresh-${Date.now()}.example/`;
    expect(before(await order(fresh), "fetch", "playwright")).toBe(true);
    // A screenshot needs a browser no matter what the host is.
    expect(
      before(await order(fresh, ["screenshot"]), "playwright", "fetch"),
    ).toBe(true);
    // quotes.toscrape.com was remembered as needing a browser above.
    expect(
      before(
        await order("https://quotes.toscrape.com/"),
        "playwright",
        "fetch",
      ),
    ).toBe(true);
  });
});
