// fork: the JS-shell test is ported from apps/local/src/browser.rs; these are
// its shell_detection and link_share_and_nav_only_shells cases.
import { linkTextShare, needsBrowser, visibleText } from "./fork-fetch-first";

const words = (n: number) => "word ".repeat(n);

describe("fork fetch-first shell detection", () => {
  it("flags shells and keeps static pages", () => {
    const shell =
      '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
    expect(needsBrowser(shell, "")).toBeDefined();
    const article = `<html><body><p>${words(200)}</p><script></script></body></html>`;
    expect(needsBrowser(article, words(200))).toBeUndefined();
    expect(
      needsBrowser("<html><body><p>Hi</p></body></html>", "Hi"),
    ).toBeUndefined();
    const dataPage = `<html><body><div class="quotes"></div><script>var data = [${'{"text":"q"},'.repeat(400)}];</script></body></html>`;
    expect(needsBrowser(dataPage, words(20))).toBeDefined();
    const app = `<html><body><div ng-view></div><p>${words(80)}</p><script src="/app.js"></script></body></html>`;
    expect(needsBrowser(app, words(80))).toBeDefined();
    // Stricter than the Rust original: a short page with a script renders.
    const small = `<html><body><p>${words(30)}</p><script src="/a.js"></script></body></html>`;
    expect(needsBrowser(small, words(30))).toBe("short page with scripts");
    const medium = `<html><body><p>${words(100)}</p><script src="/a.js"></script></body></html>`;
    expect(needsBrowser(medium, words(100))).toBeUndefined();
  });

  it("measures link text and flags navigation-only framework pages", () => {
    expect(linkTextShare("[abcd](https://x.dev/long/url) ef")).toBeCloseTo(
      4 / 6,
    );
    expect(linkTextShare("plain text only")).toBe(0);
    const nav = Array.from(
      { length: 200 },
      (_, i) => `- [Section number ${i}](https://x.dev/s/${i})\n`,
    ).join("");
    const html =
      '<html><body><div id="__nuxt"><nav></nav></div><script src="/a.js"></script></body></html>';
    expect(needsBrowser(html, nav)).toBe("navigation only");
    expect(needsBrowser(html, words(800))).toBeUndefined();
    expect(
      needsBrowser("<html><body><nav></nav></body></html>", nav),
    ).toBeUndefined();
  });

  it("drops scripts and styles from the rough visible text", () => {
    expect(
      visibleText(
        "<p>a</p><script>var x = 1</script><style>p{}</style><b>b</b>",
      ).replace(/\s+/g, ""),
    ).toBe("ab");
  });
});
