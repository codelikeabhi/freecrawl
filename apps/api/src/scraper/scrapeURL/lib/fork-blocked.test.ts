// fork: the blocked-page classifier is a pure function, and live bot walls
// cannot be summoned on demand, so it gets a unit test.
import { blockedReason } from "./fork-blocked";

describe("blockedReason", () => {
  it("flags blocking status codes", () => {
    expect(blockedReason(403, "<html></html>")).toBe("HTTP 403");
    expect(blockedReason(429, "")).toBe("HTTP 429");
  });

  it("flags challenge page titles on a 200", () => {
    expect(
      blockedReason(
        200,
        "<html><head><title>Just a moment...</title></head></html>",
      ),
    ).toBe('challenge page ("Just a moment...")');
  });

  it("flags challenge scripts on short pages", () => {
    expect(
      blockedReason(
        200,
        '<script src="https://challenges.cloudflare.com/x.js"></script>',
      ),
    ).toBe("Cloudflare challenge");
    expect(
      blockedReason(
        200,
        '<iframe src="https://geo.captcha-delivery.com/c"></iframe>',
      ),
    ).toBe("DataDome challenge");
  });

  it("flags a page with scripts but almost no text", () => {
    expect(blockedReason(200, "<script>app()</script>", "  ")).toBe(
      "almost no content",
    );
  });

  it("passes normal pages", () => {
    const page = `<html><head><title>Example Domain</title></head><body>${"text ".repeat(50)}</body></html>`;
    expect(blockedReason(200, page, "text ".repeat(50))).toBeUndefined();
    expect(blockedReason(404, page, "Not found page")).toBeUndefined();
  });
});
