// fork: local OCR (PLAN.md Phase 8, D6). Our MinerU service speaks FirePDF's
// /ocr contract (apps/ocr-service). Upstream's FirePDF tests need fire-engine
// or the Firecrawl test site; these use the upstream fixtures by upload.
// Image uploads are covered by upstream scrape-image-ocr.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, parse, parseWithFailure, scrapeTimeout } from "./lib";

const FORK_OCR = !!config.FIRE_PDF_BASE_URL && !!config.FIRE_PDF_ENABLE;

const fixture = (name: string) => ({
  content: readFileSync(path.join(__dirname, "..", "fixtures", name)),
  filename: name,
  contentType: "application/pdf",
});

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-ocr",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(FORK_OCR)("Fork: local OCR behind FirePDF's contract", () => {
  it(
    "OCRs a scanned PDF with no text layer, with page markdown",
    async () => {
      const result = await parse(
        {
          options: {
            formats: ["markdown"],
            parsers: [{ type: "pdf", mode: "auto", pages: true }],
          },
          file: fixture("parse-scanned.pdf"),
        },
        identity,
      );

      expect(result.markdown).toContain("Valve 7");
      expect(result.pages).toHaveLength(result.metadata.numPages!);
      expect(result.pages![0].markdown).toContain("Valve 7");
    },
    scrapeTimeout * 2,
  );

  it(
    "OCRs a text PDF when ocr mode is forced",
    async () => {
      const result = await parse(
        {
          options: {
            formats: ["markdown"],
            parsers: [{ type: "pdf", mode: "ocr" }],
          },
          file: fixture("parse-text.pdf"),
        },
        identity,
      );

      expect(result.markdown).toContain("Quarterly Field Notes");
    },
    scrapeTimeout * 2,
  );

  it(
    "fails cleanly for a corrupt PDF",
    async () => {
      const response = await parseWithFailure(
        {
          options: { formats: ["markdown"] },
          file: {
            content: Buffer.from("%PDF-1.7\n%not a real document body\n"),
            filename: "corrupt.pdf",
            contentType: "application/pdf",
          },
        },
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.code).toBeDefined();
    },
    scrapeTimeout,
  );

  describeIf(!!config.PDF_RUST_EXTRACT_ENABLE)("fast mode", () => {
    it(
      "refuses OCR for a scanned PDF",
      async () => {
        const response = await parseWithFailure(
          {
            options: {
              formats: ["markdown"],
              parsers: [{ type: "pdf", mode: "fast" }],
            },
            file: fixture("parse-scanned.pdf"),
          },
          identity,
        );

        expect(response.code).toBe("SCRAPE_PDF_OCR_REQUIRED");
      },
      scrapeTimeout,
    );
  });
});
