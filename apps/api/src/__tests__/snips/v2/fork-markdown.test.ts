// fork: markdown quality on docs-style HTML (lib/fork-markdown-prepass.ts).
// Uploaded through /v2/parse, so it needs no network.
import { describeIf } from "../lib";
import { config } from "../../../config";
import { idmux, Identity, parse, scrapeTimeout } from "./lib";

const DOC = `<html><head><title>Guide</title></head><body><main>
<h1>Guide <a class="headerlink" href="https://x.test/p#guide" title="Link to this heading">¶</a></h1>
<h2><a class="toc-backref" href="https://x.test/p#id2" role="doc-backlink">Usage</a><a class="headerlink" href="https://x.test/p#usage">¶</a></h2>
<p>Run the event loop:</p>
<div class="highlight-python3 notranslate"><div class="highlight"><button class="copybutton" title="Copy to clipboard">Copy</button><pre><span class="k">import</span> asyncio
asyncio.run(main())</pre></div></div>
<h3>State <a href="https://x.test/p#state" aria-label="Link for State" class="mdx-header-anchor"><svg></svg></a></h3>
<pre class="sp-cm sp-pristine sp-javascript"><code><div class="cm-line">const [count, setCount] = useState(0);</div><div class="cm-line">setCount(1);</div></code></pre>
<div class="highlight-unknownlang"><pre>plain block</pre></div>
<button aria-expanded="false">What is Freecrawl?</button><p>An answer.</p>
</main></body></html>`;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fork-markdown",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(!!config.USE_GO_MARKDOWN_PARSER)("Fork: docs-style markdown", () => {
  let markdown = "";

  beforeAll(async () => {
    const result = await parse(
      {
        options: { formats: ["markdown"] },
        file: {
          content: DOC,
          filename: "guide.html",
          contentType: "text/html",
        },
      },
      identity,
    );
    markdown = result.markdown ?? "";
  }, scrapeTimeout);

  it("fences code with the language from docs-generator classes", () => {
    expect(markdown).toContain(
      "```python\nimport asyncio\nasyncio.run(main())\n```",
    );
    expect(markdown).toContain(
      "```javascript\nconst [count, setCount] = useState(0);\nsetCount(1);\n```",
    );
  });

  it("drops copy buttons and heading anchors but keeps heading text", () => {
    expect(markdown).not.toMatch(/^Copy$/m);
    expect(markdown).not.toContain("¶");
    expect(markdown).not.toMatch(/Link (to|for)/);
    expect(markdown).toMatch(/^## Usage$/m);
    expect(markdown).toMatch(/^### State$/m);
  });

  it("keeps content buttons and leaves unknown languages unlabeled", () => {
    expect(markdown).toContain("What is Freecrawl?");
    expect(markdown).toContain("```\nplain block\n```");
  });
});

// Upstream's post-processing (native/src/html.rs) counted every "[": one
// unclosed bracket put a backslash at the end of every later line.
describeIf(!!config.USE_GO_MARKDOWN_PARSER)("Fork: stray brackets", () => {
  it(
    "keeps line breaks plain after an unclosed bracket, and inside links escaped",
    async () => {
      const result = await parse(
        {
          options: { formats: ["markdown"] },
          file: {
            content: `<html><body><main><p>A range like <code>[4,9)</code> stops before 9.</p>
<h3>Next</h3><p>More text.</p>
<a href="https://x.test/card"><h4>Card title</h4><p>Card text</p></a>
<p>Last.</p></main></body></html>`,
            filename: "brackets.html",
            contentType: "text/html",
          },
        },
        identity,
      );
      const md = result.markdown ?? "";
      expect(md).toContain("### Next\n\nMore text.");
      expect(md).toMatch(/Last\.$/);
      expect(
        md.split("\n").filter(l => l.endsWith("\\")).length,
      ).toBeGreaterThan(0);
      const after = md.slice(md.indexOf("](https://x.test/card)"));
      expect(after.split("\n").some(l => l.endsWith("\\"))).toBe(false);
    },
    scrapeTimeout,
  );
});

describe("Fork: page warnings", () => {
  it(
    "warns when a page that succeeded is a 'not found' page",
    async () => {
      const result = await parse(
        {
          options: { formats: ["markdown"] },
          file: {
            content:
              "<html><head><title>Acme | Page not found</title></head><body><main><h1>Sorry</h1><p>We could not find that page.</p></main></body></html>",
            filename: "missing.html",
            contentType: "text/html",
          },
        },
        identity,
      );
      expect(result.warning).toMatch(/not found/);
    },
    scrapeTimeout,
  );
});
