// fork: /v2/monitor with auth off (PLAN.md Phase 12). Tables in the main DB
// on nuq-postgres (fork/state/monitor.sql), scheduler started with
// FORK_LOCAL_STATE. Upstream's monitor snips need Firecrawl's test site.
// Webhook delivery is checked by hand with a receiver on the Mac.
import { describeIf } from "../lib";
import {
  idmux,
  Identity,
  monitorCheckRaw,
  monitorCreateRaw,
  monitorDeleteRaw,
  monitorPatchRaw,
  monitorRunRaw,
  scrapeTimeout,
} from "./lib";

const FORK_MONITOR = process.env.FORK_LOCAL_STATE === "true";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-monitor",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// A check finishes when the reconciler (once a minute) sees all its pages.
async function runAndWait(monitorId: string) {
  const run = await monitorRunRaw(monitorId, identity);
  expect(run.statusCode).toBe(200);
  const checkId = run.body.data.id;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const check = await monitorCheckRaw(monitorId, checkId, identity);
    if (["completed", "partial", "failed"].includes(check.body.data?.status)) {
      return check.body.data;
    }
  }
  throw new Error(`check ${checkId} did not finish`);
}

describeIf(FORK_MONITOR)("Fork: monitors with auth off", () => {
  it(
    "runs checks and reports new, then changed and same pages",
    async () => {
      const created = await monitorCreateRaw(
        {
          name: "fork-monitor test",
          schedule: { cron: "*/5 * * * *" },
          targets: [
            {
              type: "scrape",
              urls: [
                "https://httpbin.org/uuid",
                "https://quotes.toscrape.com/tag/love/",
              ],
            },
          ],
        },
        identity,
      );
      expect(created.statusCode).toBe(200);
      const id = created.body.data.id;
      try {
        const first = await runAndWait(id);
        expect(first.status).toBe("completed");
        expect(first.summary).toMatchObject({ totalPages: 2, new: 2 });

        const second = await runAndWait(id);
        expect(second.summary).toMatchObject({ changed: 1, same: 1 });
        const changed = second.pages.find((p: any) => p.status === "changed");
        expect(changed.url).toBe("https://httpbin.org/uuid");
      } finally {
        await monitorDeleteRaw(id, identity);
      }
    },
    scrapeTimeout * 6,
  );

  it(
    "refuses a schedule under five minutes and a run while paused",
    async () => {
      const tooOften = await monitorCreateRaw(
        {
          name: "too often",
          schedule: { cron: "* * * * *" },
          targets: [{ type: "scrape", urls: ["https://example.com"] }],
        },
        identity,
      );
      expect(tooOften.statusCode).toBe(400);

      const created = await monitorCreateRaw(
        {
          name: "paused",
          schedule: { cron: "0 * * * *" },
          targets: [{ type: "scrape", urls: ["https://example.com"] }],
        },
        identity,
      );
      const id = created.body.data.id;
      try {
        await monitorPatchRaw(id, { status: "paused" }, identity);
        const run = await monitorRunRaw(id, identity);
        expect(run.statusCode).toBe(409);
      } finally {
        await monitorDeleteRaw(id, identity);
      }
    },
    scrapeTimeout,
  );
});
