// fork: redactPII through our Presidio service behind fire-privacy's
// /redact contract (PLAN.md Phase 11, D7). Uploaded via /v2/parse, offline.
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, parse, scrapeTimeout } from "./lib";

const PAGE = `<html><body><main><h1>Contact</h1>
<p>Write to Jane Doe at jane.doe@example.org or call (650) 253-0000. She lives in Springfield, Illinois.</p>
<p>Card 4111 1111 1111 1111. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789. Docs: <a href="https://example.com/docs">docs</a>.</p>
</main></body></html>`;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-privacy",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const redact = async (redactPII: unknown, content = PAGE) =>
  parse(
    {
      options: { formats: ["markdown"], redactPII } as any,
      file: { content, filename: "page.html", contentType: "text/html" },
    },
    identity,
  );

describeIf(!!config.FIRE_PRIVACY_URL)("Fork: PII redaction", () => {
  it(
    "tags people, places, contacts, cards and tokens, and keeps links",
    async () => {
      const { markdown } = await redact(true);
      for (const tag of [
        "PERSON",
        "EMAIL_ADDRESS",
        "PHONE_NUMBER",
        "LOCATION",
        "CREDIT_CARD",
        "API_KEY",
      ]) {
        expect(markdown).toContain(`<${tag}>`);
      }
      expect(markdown).not.toMatch(/jane\.doe|253-0000|4111|ghp/);
      expect(markdown).toContain("[docs](https://example.com/docs)");
    },
    scrapeTimeout,
  );

  it(
    "keeps names in fast mode and masks only the chosen entities",
    async () => {
      const fast = await redact({ mode: "fast" });
      expect(fast.markdown).toContain("Jane Doe");
      expect(fast.markdown).toContain("<EMAIL_ADDRESS>");

      const masked = await redact({
        replaceStyle: "mask",
        entities: ["EMAIL"],
      });
      expect(masked.markdown).toContain("Jane Doe");
      expect(masked.markdown).toMatch(/\*{20}/);
      expect(masked.markdown).toContain("4111");
    },
    scrapeTimeout,
  );

  it(
    "withholds an oversized page with a warning instead of an empty success",
    async () => {
      const big = `<html><body><main>${"<p>lorem ipsum dolor sit amet</p>".repeat(12000)}</main></body></html>`;
      const result = await redact(true, big);
      expect(result.markdown).toBe("");
      expect(result.warning).toMatch(/withheld/);
    },
    scrapeTimeout,
  );
});
