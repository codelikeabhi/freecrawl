// fork: Redis stand-in for the Bigtable tables Cloud keeps (PLAN.md Phase 10,
// D10): job access and scrape state (GET /v2/scrape/:id) and change-tracking
// history. On with FORK_LOCAL_STATE=true, used only where the matching
// Bigtable table is not configured. Redis persists to the redis-data volume.
import { getRedisConnection } from "../services/queue-service";

export const forkLocalState = () => process.env.FORK_LOCAL_STATE === "true";

const key = (namespace: string, id: string) => `fork-state:${namespace}:${id}`;

export async function forkStateGet(
  namespace: string,
  id: string,
): Promise<string | null> {
  if (!forkLocalState()) return null;
  return getRedisConnection().get(key(namespace, id));
}

/** Stores a value; with `expiresAt` it disappears then, like a Bigtable GC rule. */
export async function forkStateSet(
  namespace: string,
  id: string,
  value: string,
  expiresAt?: Date,
): Promise<boolean> {
  if (!forkLocalState()) return false;
  const redis = getRedisConnection();
  if (expiresAt === undefined) {
    await redis.set(key(namespace, id), value);
    return true;
  }
  const ttlMs = expiresAt.getTime() - Date.now();
  if (ttlMs <= 0) return false;
  await redis.set(key(namespace, id), value, "PX", ttlMs);
  return true;
}
