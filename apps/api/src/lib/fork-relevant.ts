// fork: keep the parts of a long page that matter to the request (BEYOND
// item 9). The local model's window is 32k tokens, and upstream keeps only the
// start of a page that does not fit, so facts near the end were lost
// (AI_EVAL.md). Here the page is cut into heading-aware sections, ranked with
// BM25 against the prompt and the schema's field names and descriptions, and
// the best sections are sent in page order, with the opening always kept.

const WORD = /[\p{L}\p{N}]+/gu;
// English function words, plus JSON Schema's own vocabulary.
const STOP = new Set(
  (
    "a an and are as at be by for from has have in is it its of on or that the " +
    "this to was were will with what which who whom whose when where why how " +
    "all any each list get find extract return page content data value values " +
    "type object properties property string number integer boolean array items " +
    "required description null enum format additionalproperties"
  ).split(" "),
);

const words = (text: string) =>
  (text.normalize("NFKC").match(WORD) ?? [])
    .map(w => w.toLowerCase())
    .filter(w => w.length > 1 && !STOP.has(w));

/** Search terms from a prompt and a JSON schema (camelCase and snake_case split). */
export function queryTerms(...texts: (string | undefined)[]): string[] {
  const split = texts
    .filter((t): t is string => !!t)
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ");
  return [...new Set(words(split))];
}

/** Sections of at most about maxChars, cut at headings, then blank lines. */
export function splitSections(markdown: string, maxChars = 2000): string[] {
  const blocks = markdown.split(/\n(?=#{1,6} )|\n{2,}/);
  const sections: string[] = [];
  let current = "";
  for (const block of blocks) {
    const startsHeading = /^#{1,6} /.test(block);
    if (
      current &&
      (startsHeading || current.length + 2 + block.length > maxChars)
    ) {
      sections.push(current);
      current = "";
    }
    // ponytail: a single huge block (a long table) is cut by lines.
    if (block.length > maxChars) {
      let part = "";
      for (const line of block.split("\n")) {
        if (part && part.length + 1 + line.length > maxChars) {
          sections.push(part);
          part = "";
        }
        part += (part ? "\n" : "") + line;
      }
      current = part;
    } else {
      current += (current ? "\n\n" : "") + block;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** BM25 score of each section for the terms (k1 1.2, b 0.75). */
export function bm25(sections: string[], terms: string[]): number[] {
  const docs = sections.map(words);
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(docs.length, 1);
  const df = new Map<string, number>();
  for (const d of docs)
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map(d => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }
    return score;
  });
}

// ponytail: bytes / 3 overestimates tokens for prose (about 4 bytes each), so
// the pick stays inside the budget; the caller's exact trim is the backstop.
const estTokens = (s: string) => Math.ceil(Buffer.byteLength(s, "utf8") / 3);

/**
 * The most relevant sections of a page that does not fit maxTokens, in page
 * order, with "[...]" where sections were left out. Undefined when the page
 * fits, or when nothing in the request matches the page (the caller then
 * keeps the start, as upstream does).
 */
export function selectRelevant(
  markdown: string,
  maxTokens: number,
  terms: string[],
): { text: string; kept: number; total: number } | undefined {
  if (estTokens(markdown) <= maxTokens || terms.length === 0) return undefined;
  const sections = splitSections(markdown);
  const scores = bm25(sections, terms);
  if (!scores.some(s => s > 0)) return undefined;

  const keep = new Set<number>([0]);
  let used = estTokens(sections[0]);
  const order = scores
    .map((s, i) => [s, i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (keep.has(i)) continue;
    const cost = estTokens(sections[i]) + 2;
    if (used + cost > maxTokens) continue;
    keep.add(i);
    used += cost;
  }

  const parts: string[] = [];
  sections.forEach((s, i) => {
    if (keep.has(i)) parts.push(s);
    else if (parts[parts.length - 1] !== "[...]") parts.push("[...]");
  });
  return { text: parts.join("\n\n"), kept: keep.size, total: sections.length };
}

// ponytail: once sections are ranked the best ones fit well under the window,
// and the 9B model reads 12k tokens in about half the time of 23k. Raise it
// with a faster or larger model.
export const relevantBudget = (windowBudget: number) =>
  Math.min(windowBudget, 12_000);

export const relevanceWarning = (kept: number, total: number) =>
  `The page was too long for the model and was trimmed to the ${kept} of its ${total} sections that best match the request ("[...]" marks the rest).`;
