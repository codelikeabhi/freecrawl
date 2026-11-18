import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
import type { TeamPlanClass } from "../../lib/team-plan-class";

// fork: the self-hosted backends below only get include/excludeDomains as a
// `site:` hint, which many engines ignore. Enforce them on the returned URLs.
function keepDomains(
  res: SearchV2Response,
  include?: string[],
  exclude?: string[],
): SearchV2Response {
  if (!include?.length && !exclude?.length) return res;
  const matches = (host: string, domain: string) => {
    const d = domain.toLowerCase().replace(/^www\./, "");
    return host === d || host.endsWith("." + d);
  };
  const allowed = (url?: string) => {
    try {
      const host = new URL(url ?? "").hostname.toLowerCase();
      return (
        (!include?.length || include.some(d => matches(host, d))) &&
        !exclude?.some(d => matches(host, d))
      );
    } catch {
      return false;
    }
  };
  return {
    ...res,
    ...(res.web ? { web: res.web.filter(r => allowed(r.url)) } : {}),
    ...(res.news ? { news: res.news.filter(r => allowed(r.url)) } : {}),
    ...(res.images ? { images: res.images.filter(r => allowed(r.url)) } : {}),
  };
}

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  usOnly = false,
  teamPlanClass = undefined,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  usOnly?: boolean;
  /** The team's plan class, when the caller knows it. Omitted, nothing is stated. */
  teamPlanClass?: TeamPlanClass;
}): Promise<SearchV2Response> {
  // The fallback backends below take no US-only routing.
  if (usOnly && !config.FIRE_ENGINE_BETA_URL) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
        usOnly,
        teamPlanClass,
      });

      return results;
    }

    // includeDomains/excludeDomains reach the fallback providers below as the
    // site: chain baked into the query; fork: keepDomains also enforces them
    // on the returned URLs.
    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const results = keepDomains(
        await searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
          safe,
          type, // fork: news and images come from SearXNG's categories
        }),
        includeDomains,
        excludeDomains,
      );
      if (results.web?.length || results.news?.length || results.images?.length)
        return results;
    }

    logger.info("Using DuckDuckGo search");
    const ddgResults = keepDomains(
      await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      }),
      includeDomains,
      excludeDomains,
    );
    if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
