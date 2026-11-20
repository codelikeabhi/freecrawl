// fork: the blocked-page classifier is a pure function, and live bot walls
// cannot be summoned on demand, so it gets a unit test.
import { blockedReason, pageWarning } from "./fork-blocked";

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
    // Seen in the benchmark: the site name comes first.
    expect(
      blockedReason(200, "<title>Reddit - Prove your humanity</title>"),
    ).toBe('challenge page ("Prove your humanity")');
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

describe("pageWarning", () => {
  const page = (title: string, body = "<p>text</p>") =>
    `<html><head><title>${title}</title></head><body>${body}</body></html>`;

  it("flags soft 404 titles, with or without a site prefix", () => {
    expect(pageWarning(200, page("404 - Page Not Found"))).toMatch(/not found/);
    expect(pageWarning(200, page("Acme | Page not found"))).toMatch(
      /not found/,
    );
  });

  it("flags a short page that is mostly a sign-in form", () => {
    const form =
      '<form><input name="u"><input type="password" name="p"></form>';
    expect(pageWarning(200, page("Sign in", form))).toMatch(/sign-in/);
  });

  it("passes articles about 404s, real error statuses and long pages", () => {
    expect(pageWarning(200, page("How to fix a 404 error"))).toBeUndefined();
    expect(pageWarning(404, page("404 Not Found"))).toBeUndefined();
    const long = page(
      "Docs",
      '<input type="password">' + "<p>x</p>".repeat(5000),
    );
    expect(pageWarning(200, long)).toBeUndefined();
  });
});
