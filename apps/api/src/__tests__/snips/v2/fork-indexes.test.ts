// fork: research, developer and gov indexes over free public APIs (PLAN.md
// Phase 3b). Upstream's research/developer/gov snips cover the dedicated
// routes; these cover the /v2/search category form, a found protein, and a
// paper that does not exist.
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, researchRaw, search } from "./lib";

const hostOf = (url: string) => new URL(url).hostname;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-indexes",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describeIf(!!config.RESEARCH_PROXY_URL && !!config.SEARCH_PLATFORM_URL)(
  "Fork: research, developer and gov indexes",
  () => {
    it.concurrent(
      "serves the developer category from the index service",
      async () => {
        const res = await search(
          {
            query: "playwright click timeout",
            limit: 5,
            categories: ["developer"],
          },
          identity,
        );
        expect(res.web?.length).toBeGreaterThan(0);
        expect(res.web!.every(r => r.category === "developer")).toBe(true);
      },
      120000,
    );

    it.concurrent(
      "serves the gov category from government sources only",
      async () => {
        const res = await search(
          {
            query: "food labeling requirements",
            limit: 5,
            categories: ["gov"],
          },
          identity,
        );
        expect(res.web?.length).toBeGreaterThan(0);
        expect(res.web!.every(r => /\.(gov|mil|us)$/.test(hostOf(r.url)))).toBe(
          true,
        );
      },
      120000,
    );

    it.concurrent(
      "finds a protein by gene name",
      async () => {
        const res = await researchRaw(
          "/v2/search/research/proteins",
          { protein: "TP53" },
          identity,
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.match).toBe("found");
        expect(res.body.protein.accession).toBe("P04637");
        expect(res.body.notice).toMatch(/CC BY 4\.0/);
      },
      120000,
    );

    it.concurrent(
      "answers 404 for a paper that does not exist",
      async () => {
        const res = await researchRaw(
          "/v2/search/research/papers/9999.99999",
          undefined,
          identity,
        );
        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
      },
      120000,
    );
  },
);
