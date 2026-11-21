// fork: per-host politeness (BEYOND item 6). Upstream never backs off when a
// site answers 429 and never reads Retry-After; on a home IP every refusal
// costs reputation the stealth engine depends on. One Redis key per host holds
// the earliest time the next request may start, shared by scrape, batch,
// crawl and every engine attempt: each attempt reserves a slot FORK_HOST_GAP_MS
// after the previous one, and a 429 or 503 pushes the next slot back by
// Retry-After or by an exponential backoff (1 s, 2 s, 4 s ... 60 s).
import { setTimeout as sleep } from "timers/promises";
import { getRedisConnection } from "../../../services/queue-service";

const gapMs = () => Number(process.env.FORK_HOST_GAP_MS ?? 0);
const MAX_WAIT_MS = 60_000;
const slotKey = (url: string) => `fork-host:next:${new URL(url).hostname}`;
const strikeKey = (url: string) => `fork-host:strikes:${new URL(url).hostname}`;

// Reserves the next start slot: returns how long to wait for it.
// KEYS[1] slot key; ARGV now, gap.
const RESERVE = `
local now = tonumber(ARGV[1])
local start = math.max(now, tonumber(redis.call('GET', KEYS[1]) or 0))
redis.call('SET', KEYS[1], start + ARGV[2], 'PX', start + ARGV[2] - now + 1000)
return start - now`;

// Pushes the next slot to at least now + delay (never earlier).
const PUSH = `
local now = tonumber(ARGV[1])
local until_ = math.max(now + tonumber(ARGV[2]), tonumber(redis.call('GET', KEYS[1]) or 0))
redis.call('SET', KEYS[1], until_, 'PX', until_ - now + 1000)
return until_ - now`;

export const pacingOn = () => gapMs() > 0;

/** Waits for this host's next slot. Returns the milliseconds waited. */
export async function waitForHost(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  if (!pacingOn()) return 0;
  let wait: number;
  try {
    wait = Number(
      await getRedisConnection().eval(
        RESERVE,
        1,
        slotKey(url),
        Date.now(),
        gapMs(),
      ),
    );
  } catch {
    return 0; // ponytail: pacing is politeness; a Redis hiccup must not fail scrapes
  }
  wait = Math.min(wait, MAX_WAIT_MS);
  if (wait > 0) await sleep(wait, undefined, { signal });
  return wait;
}

/** Seconds or an HTTP date, as Retry-After allows; undefined when unusable. */
export function parseRetryAfter(
  value: string | undefined | null,
): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * After a 429, or a 503 that says when to come back: delays this host's
 * next request. Returns the delay in milliseconds, or 0 when none applies.
 */
export async function backOffHost(
  url: string,
  statusCode: number,
  retryAfter?: string,
): Promise<number> {
  if (!pacingOn()) return 0;
  const asked = parseRetryAfter(retryAfter);
  if (statusCode !== 429 && !(statusCode === 503 && asked !== undefined))
    return 0;
  try {
    const redis = getRedisConnection();
    const strikes = await redis.incr(strikeKey(url));
    await redis.expire(strikeKey(url), 600);
    const delay = Math.min(asked ?? 1000 * 2 ** (strikes - 1), MAX_WAIT_MS);
    return Number(await redis.eval(PUSH, 1, slotKey(url), Date.now(), delay));
  } catch {
    return 0;
  }
}
