// fork: Retry-After parsing for per-host pacing (fork-host-pace.ts).
import { parseRetryAfter } from "./fork-host-pace";

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and ignores junk", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    const inTen = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(inTen)!;
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(0);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
