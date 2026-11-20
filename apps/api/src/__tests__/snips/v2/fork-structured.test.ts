// fork: branding on the Playwright engine, product and menu from our
// structured service, deterministicJson in the isolated code sandbox
// (PLAN.md Phase 13). Upstream's snips for these need fire-engine,
// production or Firecrawl's test site.
import { describeIf } from "../lib";
import { config } from "../../../config";
import {
  idmux,
  Identity,
  parse,
  scrape,
  scrapeRaw,
  scrapeTimeout,
} from "./lib";

const PRODUCT = `<html><head><title>Widget</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Freecrawl Test Widget","brand":{"@type":"Brand","name":"Acme"},"sku":"W-1","offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script></head><body><main><h1>Freecrawl Test Widget</h1><p>$49.99</p></main></body></html>`;

const MENU = `<html><head><title>Blue Cup Cafe</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Blue Cup Cafe","hasMenu":{"@type":"Menu","hasMenuSection":[{"@type":"MenuSection","name":"Coffee","hasMenuItem":[{"@type":"MenuItem","name":"Oat Latte","suitableForDiet":"https://schema.org/VeganDiet","offers":{"@type":"Offer","price":"5.25","priceCurrency":"USD"}}]}]}}</script></head><body><main><h1>Menu</h1><p>Oat Latte 5.25</p></main></body></html>`;

const BOOK =
  "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-structured",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

const upload = (content: string, formats: string[]) =>
  parse(
    {
      options: { formats } as any,
      file: { content, filename: "page.html", contentType: "text/html" },
    },
    identity,
  );

describe("Fork: structured formats", () => {
  it.concurrent(
    "extracts branding on the Playwright engine",
    async () => {
      const doc = await scrape(
        { url: "https://example.com", formats: ["branding"] },
        identity,
      );
      expect(doc.branding).toBeDefined();
      expect(doc.branding!.colors).toBeDefined();
    },
    scrapeTimeout * 3,
  );

  describeIf(!!config.PRODUCT_EXTRACTION_SERVICE_URL)(
    "product and menu",
    () => {
      it.concurrent(
        "reads products and menus from schema.org data",
        async () => {
          const product = (await upload(PRODUCT, ["markdown", "product"]))
            .product as any;
          expect(product.title).toBe("Freecrawl Test Widget");
          expect(product.brand).toBe("Acme");
          expect(product.variants[0].price).toEqual({
            amount: 49.99,
            currency: "USD",
          });
          expect(product.variants[0].availability.inStock).toBe(true);

          const menu = (await upload(MENU, ["markdown", "menu"])).menu as any;
          expect(menu.merchant.name).toBe("Blue Cup Cafe");
          expect(menu.sections[0].items[0]).toMatchObject({
            name: "Oat Latte",
            price: { amount: 5.25, currency: "USD" },
            dietary: ["Vegan"],
          });
        },
        scrapeTimeout,
      );

      it.concurrent(
        "says so when a page is neither a product nor a menu",
        async () => {
          const doc = await scrape(
            { url: "https://example.com", formats: ["product", "menu"] },
            identity,
          );
          expect(doc.product).toBeUndefined();
          expect(doc.menu).toBeUndefined();
          expect(doc.warning).toMatch(/No product found/);
          expect(doc.warning).toMatch(/No menu found/);
        },
        scrapeTimeout * 2,
      );
    },
  );

  it.concurrent(
    "runs a generated extractor in the sandbox (deterministicJson)",
    async () => {
      const res = await scrapeRaw(
        {
          url: BOOK,
          formats: [
            {
              type: "deterministicJson",
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  price: { type: "string" },
                },
                required: ["title", "price"],
              },
            },
          ],
          timeout: 280000,
        },
        identity,
      );
      expect(res.body.success).toBe(true);
      expect(res.body.data.json.title).toMatch(/Light in the Attic/);
      expect(res.body.data.json.price).toMatch(/51\.77/);
    },
    300000,
  );
});
