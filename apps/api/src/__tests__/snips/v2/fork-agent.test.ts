// fork: /v2/agent through our agent service (PLAN.md Phase 15, D8): plan,
// search, scrape and merge with the local model. Upstream's live agent
// snips need production; its validation and thread-rejection ones run here.
import request from "supertest";
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity } from "./lib";

const TEST_API_URL = process.env.TEST_API_URL ?? "http://127.0.0.1:3002";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-agent",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

const api = () => request(TEST_API_URL);
const auth = () => `Bearer ${identity.apiKey}`;

async function waitFor(id: string) {
  for (let i = 0; i < 60; i++) {
    const res = await api().get(`/v2/agent/${id}`).set("Authorization", auth());
    if (res.body.status !== "processing") return res.body;
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`agent ${id} did not finish`);
}

describeIf(!!config.EXTRACT_V3_BETA_URL)("Fork: agent", () => {
  it("answers into a schema from the given URLs only", async () => {
    const created = await api()
      .post("/v2/agent")
      .set("Authorization", auth())
      .send({
        prompt:
          "List the authors of the first three quotes on the page, in page order, repeating authors who appear more than once.",
        urls: ["https://quotes.toscrape.com/"],
        strictConstrainToURLs: true,
        schema: {
          type: "object",
          properties: { authors: { type: "array", items: { type: "string" } } },
          required: ["authors"],
        },
      });
    expect(created.statusCode).toBe(200);
    const done = await waitFor(created.body.id);
    expect(done.status).toBe("completed");
    expect(done.model).toBe("spark-2");
    expect(done.data.authors).toEqual([
      "Albert Einstein",
      "J.K. Rowling",
      "Albert Einstein",
    ]);

    const trace = await api()
      .get(`/v2/agent/${created.body.id}/trace`)
      .set("Authorization", auth());
    expect(trace.body.events.map((e: any) => e.type)).toContain("run.finished");

    const list = await api().get("/v2/agent").set("Authorization", auth());
    expect(list.body.agents.map((a: any) => a.id)).toContain(created.body.id);
  }, 320000);

  it("stops at the credit limit and reports it", async () => {
    const created = await api()
      .post("/v2/agent")
      .set("Authorization", auth())
      .send({
        prompt: "Find three facts about the Eiffel Tower",
        maxCredits: 3,
      });
    const done = await waitFor(created.body.id);
    expect(done.status).toBe("failed");
    expect(done.stopReason).toBe("credit_limit_reached");
  }, 320000);
});
