// fork: fetch first, browser only when needed (BEYOND item 5). Self-hosted
// sends every page through Playwright because it has the higher engine
// quality; Cloud picks per domain with engpicker, which needs its index DB.
// With FORK_FETCH_FIRST=true a plain HTTP fetch goes first, its result is
// kept unless it is a JavaScript shell or blocked, and each host's verdict is
// remembered in Redis so the next page of that host skips the failed try.
import { getRedisConnection } from "../../../services/queue-service";
import type { Meta } from "..";
import type { FeatureFlag } from "../engines";
import { useFireEngine } from "../engines/fire-engine/available";

export const fetchFirst = () => process.env.FORK_FETCH_FIRST === "true";

export type HostVerdict = "browser" | "stealth";

const key = (url: string) => `fork-engine:${new URL(url).hostname}`;
// ponytail: fixed TTLs. A site's rendering rarely changes; IP reputation
// changes by the hour, so a stealth verdict is kept only a day.
const TTL_S: Record<HostVerdict, number> = {
  browser: 7 * 24 * 3600,
  stealth: 24 * 3600,
};

async function hostVerdict(url: string): Promise<HostVerdict | null> {
  if (!fetchFirst()) return null;
  try {
    return (await getRedisConnection().get(key(url))) as HostVerdict | null;
  } catch {
    return null;
  }
}

/** True when this scrape puts fetch ahead of the browser engines. */
export async function fetchGoesFirst(meta: Meta): Promise<boolean> {
  return (
    fetchFirst() &&
    !useFireEngine &&
    meta.mock === null &&
    !meta.fetchPrefetch &&
    meta.internalOptions.forceEngine === undefined &&
    (await hostVerdict(meta.url)) === null
  );
}

/** Remembers what a host needed. A stealth verdict is never downgraded. */
export async function rememberHost(
  url: string,
  verdict: HostVerdict,
): Promise<void> {
  if (!fetchFirst()) return;
  try {
    const redis = getRedisConnection();
    if (verdict === "browser" && (await redis.get(key(url))) === "stealth")
      return;
    await redis.set(key(url), verdict, "EX", TTL_S[verdict]);
  } catch {
    // ponytail: memory is an optimization; a Redis hiccup only costs a retry.
  }
}

/**
 * After stealth ran on an auto-proxy scrape (escalated, or sent there by a
 * remembered verdict): keep the stealth verdict only while stealth gets
 * through. When it is blocked too, the host goes back to the normal ladder,
 * since on some sites (reddit, glassdoor) the plain browser does better.
 */
export async function noteStealthResult(
  url: string,
  blocked: boolean,
  ok: boolean,
): Promise<void> {
  if (!fetchFirst()) return;
  try {
    const redis = getRedisConnection();
    if (blocked) {
      if ((await redis.get(key(url))) === "stealth")
        await redis.set(key(url), "browser", "EX", TTL_S.browser);
    } else if (ok) {
      await redis.set(key(url), "stealth", "EX", TTL_S.stealth);
    }
  } catch {
    // see rememberHost
  }
}

/**
 * Adds the stealth flag up front for hosts that needed it recently, on
 * auto-proxy scrapes that do not pin an engine or a profile.
 */
export async function withRememberedStealth(
  flags: Set<FeatureFlag>,
  url: string,
  options: { proxy?: string; lockdown?: boolean; profile?: unknown },
  engineForced: boolean,
): Promise<Set<FeatureFlag>> {
  if (
    engineForced ||
    options.lockdown ||
    options.profile ||
    options.proxy !== "auto" ||
    !process.env.FORK_STEALTH_URL ||
    flags.has("stealthProxy")
  )
    return flags;
  if ((await hostVerdict(url)) === "stealth") flags.add("stealthProxy");
  return flags;
}

// Plain undici announces itself as "node", which many sites refuse. A Chrome
// user agent from a non-Chrome TLS stack is worse (w3.org answers 403), and
// the FirecrawlAgent token is on AI-bot block lists (medium.com, zillow.com).
// A generic "compatible" agent did best on 20 sites (2026-11-21): it names no
// one and claims no browser. The browser engines keep their own agents.
export const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; web-reader/1.0)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Rough visible text of an HTML page, for results without markdown. */
export const visibleText = (html: string) =>
  html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");

const visibleCount = (markdown: string) => markdown.replace(/\s/g, "").length;

const MOUNT_POINTS = [
  'id="root"',
  'id="app"',
  'id="__next"',
  'id="__nuxt"',
  'id="svelte"',
  'id="___gatsby"',
  "data-reactroot",
  "ng-app",
  "ng-view",
  "ng-version",
  "<app-root",
  'id="q-app"',
  'id="elm"',
];
const FRAMEWORKS = [
  'id="__nuxt"',
  'id="__next"',
  'id="root"',
  'id="app"',
  "ng-version",
  "<app-root",
  'id="___gatsby"',
  'id="svelte"',
];
const ASKS_FOR_JS =
  /enable javascript|requires javascript|javascript is disabled|javascript is required|need to enable javascript/;

// Ported from Firecrawl's own apps/local/src/browser.rs (needs_browser,
// link_text_share, looks_like_nav_only_shell), same thresholds.

/** Why a fetched page needs a browser, or undefined when it does not. */
export function needsBrowser(
  html: string,
  markdown: string,
): string | undefined {
  const visible = visibleCount(markdown);
  const head = html.slice(0, 200_000).toLowerCase();
  if (visible >= 1500) {
    return looksLikeNavOnlyShell(head, markdown, visible)
      ? "navigation only"
      : undefined;
  }
  if (!head.includes("<script")) return undefined;
  if (ASKS_FOR_JS.test(head)) return "asks for JavaScript";
  if (MOUNT_POINTS.some(m => head.includes(m))) return "app mount point";
  const ratio = visible / Math.max(html.length, 1);
  if (ratio < 0.01 && html.length > 20_000) return "text waits in scripts";
  // fork: stricter than the Rust original, which keeps a short page with
  // scripts. Here a browser is always running and a short page renders in
  // about a second, while a wrong "fetch is fine" silently loses whatever the
  // scripts add (example.com fills in its translations from /s.js).
  return visible < 300 ? "short page with scripts" : undefined;
}

/** Share of a markdown document's visible text that is link text. */
export function linkTextShare(markdown: string): number {
  let total = 0;
  let inLinks = 0;
  let depth = 0;
  let pending = 0;
  for (let i = 0; i < markdown.length; i++) {
    const c = markdown[i];
    if (c === "[") {
      depth++;
      pending = 0;
    } else if (c === "]" && depth > 0) {
      depth--;
      if (markdown[i + 1] === "(") {
        inLinks += pending;
        const close = markdown.indexOf(")", i);
        i = close === -1 ? markdown.length : close; // the URL is not visible text
      }
      pending = 0;
    } else if (!/\s/.test(c)) {
      total++;
      if (depth > 0) pending++;
    }
  }
  return total === 0 ? 0 : inLinks / total;
}

function looksLikeNavOnlyShell(
  head: string,
  markdown: string,
  visible: number,
): boolean {
  if (visible < 1500 || visible >= 12_000) return false;
  return (
    FRAMEWORKS.some(m => head.includes(m)) && linkTextShare(markdown) > 0.6
  );
}
