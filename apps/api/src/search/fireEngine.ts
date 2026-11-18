import { config } from "../config";
import { SearchResult } from "../../src/lib/entities";
import { logger } from "../lib/logger";
import { executeWithRetry, attemptRequest } from "../lib/retry-utils";
import { useFireEngine } from "../scraper/scrapeURL/engines/fire-engine/available";
import { searxngMapResults } from "./v2/searxng";

function hasResults(results: unknown): results is SearchResult[] {
  return Array.isArray(results) && results.length > 0;
}

export async function fire_engine_search(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
    usOnly?: boolean;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!useFireEngine) {
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
    ...(options.usOnly ? { usOnly: true } : {}),
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/search`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}

export async function fireEngineMap(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
    usOnly?: boolean;
    zeroDataRetention?: boolean;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!useFireEngine) {
    // fork: without Fire-engine, discover a site's pages through SearXNG.
    if (config.SEARXNG_ENDPOINT) {
      // ponytail: one call already reads up to numResults (100) across SearXNG
      // pages; deeper map pages would re-ask the same engines and invite rate limits.
      if ((options.page ?? 1) > 1) return [];
      return await searxngMapResults(q, options.numResults);
    }
    logger.warn(
      "(v1/map Beta) Results might differ from cloud offering currently.",
    );
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
    ...(options.usOnly ? { usOnly: true } : {}),
    ...(options.zeroDataRetention ? { zeroDataRetention: true } : {}),
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/map`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}
