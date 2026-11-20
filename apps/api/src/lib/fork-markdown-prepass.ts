// fork: HTML clean-up before markdown conversion (docs/fork BEYOND item 2).
// Docs sites lose their code languages and keep UI text: copy buttons, and
// "¶" / "Link for this heading" anchors inside every heading. The Go
// converter reads a code block's language only from `language-*`/`lang-*`
// classes, so known hints are rewritten into that form here.
import { load } from "cheerio";

const LANGUAGES = new Set(
  (
    "python javascript typescript jsx tsx bash shell console json yaml html css scss " +
    "go rust java c cpp csharp ruby php sql kotlin swift scala r lua perl toml xml " +
    "diff dockerfile graphql markdown powershell text ini makefile elixir haskell dart"
  ).split(" "),
);
const ALIASES: Record<string, string> = {
  python3: "python",
  py: "python",
  pycon: "python",
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  zsh: "bash",
  "shell-session": "console",
  yml: "yaml",
  golang: "go",
  rs: "rust",
  "c++": "cpp",
  cs: "csharp",
  rb: "ruby",
  kt: "kotlin",
  md: "markdown",
  ps1: "powershell",
};
const HINTS = [
  /^highlight-(?:source-)?(.+)$/,
  /^sp-(.+)$/,
  /^brush:(.+)$/,
  /^hljs-?(.+)$/,
];
const COPY_TEXT = /^\s*(copy( code| to clipboard)?|copied!?)\s*$/i;
const COPY_CLASS = /copy|clipboard/i;
const ANCHOR_CLASS =
  /headerlink|header-anchor|heading-anchor|anchor-link|hash-link|permalink|\banchor\b/i;
const ANCHOR_TEXT = /^\s*[¶#§🔗]?\s*$/u;
const ANCHOR_LABEL = /link (to|for) /i;

function language(word: string): string | null {
  const w = word.toLowerCase();
  const name = ALIASES[w] ?? w;
  return LANGUAGES.has(name) ? name : null;
}

function hintFrom(
  classes: string | undefined,
  data: string | undefined,
): string | null {
  if (data && language(data)) return language(data);
  for (const cls of (classes ?? "").split(/\s+/)) {
    if (/^(language|lang)-/.test(cls)) return null; // already understood
    for (const re of HINTS) {
      const m = cls.match(re);
      const lang = m && language(m[1]);
      if (lang) return lang;
    }
  }
  return null;
}

export function forkPrepareHtml(html: string): string {
  if (!/<(pre|button|h[1-6])\b/i.test(html)) return html;
  const $ = load(html);

  $("button").each((_, el) => {
    const b = $(el);
    if (COPY_TEXT.test(b.text()) || COPY_CLASS.test(b.attr("class") ?? ""))
      b.remove();
  });

  $("h1, h2, h3, h4, h5, h6")
    .find("a")
    .each((_, el) => {
      const a = $(el);
      const label = `${a.attr("aria-label") ?? ""} ${a.attr("title") ?? ""}`;
      if (
        a.attr("role") === "doc-backlink" ||
        /toc-backref/.test(a.attr("class") ?? "")
      ) {
        a.replaceWith(a.text()); // the heading text itself, linked back to a TOC
      } else if (
        (a.attr("href") ?? "").includes("#") &&
        (ANCHOR_CLASS.test(a.attr("class") ?? "") ||
          ANCHOR_LABEL.test(label) ||
          ANCHOR_TEXT.test(a.text()))
      ) {
        a.remove();
      }
    });

  $("pre").each((_, el) => {
    const pre = $(el);
    const code = pre.find("code").first();
    if (
      /\b(language|lang)-/.test(
        `${pre.attr("class") ?? ""} ${code.attr("class") ?? ""}`,
      )
    )
      return;
    let lang: string | null = null;
    for (
      let node = pre, depth = 0;
      node.length && depth < 4 && !lang;
      node = node.parent(), depth++
    ) {
      lang = hintFrom(
        node.attr("class"),
        node.attr("data-language") ?? node.attr("data-lang"),
      );
    }
    lang ??= hintFrom(
      code.attr("class"),
      code.attr("data-language") ?? code.attr("data-lang"),
    );
    if (lang) pre.addClass(`language-${lang}`);
  });

  return $.html();
}
