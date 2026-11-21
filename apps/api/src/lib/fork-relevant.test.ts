// fork: relevance selection for pages over the local model's window.
import {
  bm25,
  queryTerms,
  selectRelevant,
  splitSections,
} from "./fork-relevant";

const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `## Section ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(40)}`,
  ).join("\n\n");

describe("fork relevance selection", () => {
  it("takes terms from prompts and schemas, without schema words", () => {
    const terms = queryTerms(
      "When was it released?",
      JSON.stringify({
        type: "object",
        properties: { releaseDate: { type: "string" }, max_speed: {} },
      }),
    );
    expect(terms).toEqual(
      expect.arrayContaining(["released", "release", "date", "max", "speed"]),
    );
    expect(terms).not.toContain("properties");
    expect(terms).not.toContain("string");
  });

  it("cuts at headings and keeps long blocks under the size", () => {
    const parts = splitSections(
      `# A\n\nintro\n\n## B\n\n${"x\n".repeat(3000)}`,
    );
    expect(parts[0]).toBe("# A\n\nintro");
    expect(parts.every(p => p.length <= 2000)).toBe(true);
  });

  it("ranks the matching section first", () => {
    const scores = bm25(
      ["cats sleep a lot", "the tower is 330 metres tall", "dogs bark"],
      ["tower", "tall"],
    );
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[0]).toBe(0);
  });

  it("keeps the opening and a fact near the end of a long page", () => {
    const page = `# Rocket facts\n\nIntro.\n\n${filler(400)}\n\n## Engines\n\nThe Raptor engine burns methane.`;
    const picked = selectRelevant(
      page,
      3000,
      queryTerms("Which fuel does the Raptor engine burn?"),
    )!;
    expect(picked.text.startsWith("# Rocket facts")).toBe(true);
    expect(picked.text).toContain("The Raptor engine burns methane.");
    expect(picked.text).toContain("[...]");
    expect(Buffer.byteLength(picked.text) / 3).toBeLessThanOrEqual(3000);
  });

  it("leaves pages that fit, and requests that match nothing, to the caller", () => {
    expect(selectRelevant("# Short\n\npage", 3000, ["page"])).toBeUndefined();
    expect(selectRelevant(filler(400), 3000, ["zebra"])).toBeUndefined();
  });
});
