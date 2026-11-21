// fork: browser sessions and scrape-interact through our session service,
// which speaks Hangar's contract over a Unix socket (PLAN.md Phase 14).
// Upstream's session snips need Firecrawl's Hangar and test site.
import request from "supertest";
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, scrape, scrapeTimeout } from "./lib";

const TEST_API_URL = process.env.TEST_API_URL ?? "http://127.0.0.1:3002";
const FORK_SESSIONS = !!config.HANGAR_URL && !!process.env.FORK_HANGAR_SOCKET;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-sessions",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const api = () => request(TEST_API_URL);
const auth = () => `Bearer ${identity.apiKey}`;
const execute = (id: string, code: string, language = "node") =>
  api()
    .post(`/v2/browser/${id}/execute`)
    .set("Authorization", auth())
    .send({ code, language, timeout: 60 });

describeIf(FORK_SESSIONS)("Fork: browser sessions", () => {
  it(
    "runs node and bash in one session, then stops it",
    async () => {
      const created = await api()
        .post("/v2/browser")
        .set("Authorization", auth())
        .send({ ttl: 120, activityTtl: 60 });
      expect(created.statusCode).toBe(200);
      expect(created.body.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\//);
      const id = created.body.id;
      try {
        const node = await execute(
          id,
          'await page.goto("https://example.com"); return await page.title()',
        );
        expect(node.body.result).toBe("Example Domain");

        const bash = await execute(id, "agent-browser get url", "bash");
        expect(bash.body.exitCode).toBe(0);
        expect(bash.body.stdout).toContain("https://example.com");

        // Session code has no network of its own: not the API, not Redis.
        const fenced = await execute(
          id,
          'const r = []; for (const u of ["http://api:3002/", "http://redis:6379/"]) r.push(await fetch(u, { signal: AbortSignal.timeout(5000) }).then(() => "reached", () => "blocked")); return r.join(",")',
        );
        expect(fenced.body.result).toBe("blocked,blocked");
      } finally {
        const stopped = await api()
          .delete(`/v2/browser/${id}`)
          .set("Authorization", auth());
        expect(stopped.body.status).toBe("stopped");
      }
      const after = await execute(id, "return 1");
      expect(after.statusCode).toBe(410);
    },
    scrapeTimeout * 3,
  );

  it(
    "replays a scrape into a live session and acts on it",
    async () => {
      const doc = await scrape(
        { url: "https://quotes.toscrape.com/", maxAge: 0 },
        identity,
      );
      const scrapeId = doc.metadata.scrapeId!;
      const res = await api()
        .post(`/v2/scrape/${scrapeId}/interact`)
        .set("Authorization", auth())
        .send({
          code: 'await page.click("li.next a"); await page.waitForLoadState(); return page.url()',
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.result).toBe("https://quotes.toscrape.com/page/2/");
      await api()
        .delete(`/v2/scrape/${scrapeId}/interact`)
        .set("Authorization", auth());
    },
    scrapeTimeout * 3,
  );

  it(
    "refuses interact for a scrape it does not know",
    async () => {
      const res = await api()
        .post("/v2/scrape/01a1fad3-0000-7000-8000-000000000000/interact")
        .set("Authorization", auth())
        .send({ code: "return 1" });
      expect(res.statusCode).toBe(404);
    },
    scrapeTimeout,
  );
});
