// fork: per-host pacing and 429 backoff (scraper/scrapeURL/lib/fork-host-pace.ts).
import { describeIf, HAS_FIRE_ENGINE, scrapeTimeout } from "../lib";
import { idmux, Identity, scrapeRaw } from "./lib";
import { getRedisConnection } from "../../../services/queue-service";
import { waitForHost } from "../../../scraper/scrapeURL/lib/fork-host-pace";

const PACING =
  Number(process.env.FORK_HOST_GAP_MS ?? 0) > 0 && !HAS_FIRE_ENGINE;

let identity: Identity;

describeIf(PACING)("Fork: per-host politeness", () => {
  beforeAll(async () => {
    identity = await idmux({ name: "fork-politeness", credits: 1000000 });
  }, 10000);

  it("spaces out requests that start together on one host", async () => {
    const url = `https://pace-${Date.now()}.example/`;
    const waits = await Promise.all([1, 2, 3].map(() => waitForHost(url)));
    const gap = Number(process.env.FORK_HOST_GAP_MS);
    expect(waits.sort((a, b) => a - b)[0]).toBe(0);
    expect(waits[2]).toBeGreaterThanOrEqual(2 * gap - 50);
  });

  it(
    "backs off a host that answers 429 and says so",
    async () => {
      const res = await scrapeRaw(
        { url: "https://httpbin.org/status/429", proxy: "basic", maxAge: 0 },
        identity,
      );
      expect(res.body.data?.metadata?.statusCode).toBe(429);
      expect(res.body.data?.warning).toContain("429 Too Many Requests");
      const next = Number(
        await getRedisConnection().get("fork-host:next:httpbin.org"),
      );
      expect(next).toBeGreaterThan(Date.now());
    },
    scrapeTimeout,
  );
});
