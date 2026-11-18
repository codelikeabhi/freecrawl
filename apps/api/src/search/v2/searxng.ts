import axios from "axios";
import { config } from "../../config";
import {
  SearchResultType,
  SearchV2Response,
  WebSearchResult,
} from "../../lib/entities";
import { logger } from "../../lib/logger";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  num_results: number;
  page?: number;
  // fork: which result groups to return (web, news, images). Defaults to web.
  type?: SearchResultType | SearchResultType[];
  // fork: SearXNG categories for the web group. Defaults to SEARXNG_CATEGORIES.
  categories?: string;
}

// fork: SearXNG's time_range only has day/week/month/year, so Google-style
// `qdr:h` maps to day. ponytail: custom ranges (`cdr:1,cd_min:..`) and `sbd:1`
// have no SearXNG equivalent and are ignored.
const TIME_RANGES: Record<string, string> = {
  h: "day",
  d: "day",
  w: "week",
  m: "month",
  y: "year",
};

function searxngTimeRange(tbs?: string): string | undefined {
  const unit = tbs?.match(/(?:^|,)(?:qdr:)?([hdwmy])/)?.[1];
  return unit ? TIME_RANGES[unit] : undefined;
}

// fork: SearXNG encodes the region in the locale (`en-US`), it has no separate
// region parameter.
function searxngLanguage(lang?: string, country?: string): string | undefined {
  if (!lang) return undefined;
  return country && /^[a-z]{2}$/i.test(country)
    ? `${lang}-${country.toUpperCase()}`
    : lang;
}

type Group = { web: WebSearchResult[]; news: any[]; images: any[] };

const toResult: {
  [K in SearchResultType]: (a: any) => Group[K][number];
} = {
  web: a => ({ url: a.url, title: a.title, description: a.content }),
  news: a => ({
    title: a.title,
    url: a.url,
    snippet: a.content,
    date: a.publishedDate ?? undefined,
    imageUrl: a.thumbnail || a.img_src || undefined,
  }),
  images: a => {
    const [w, h] = String(a.resolution ?? "")
      .split(/\s*[x×]\s*/)
      .map(Number);
    return {
      title: a.title,
      imageUrl: a.img_src,
      url: a.url,
      ...(w > 0 && h > 0 ? { imageWidth: w, imageHeight: h } : {}),
    };
  },
};

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const types: SearchResultType[] = options.type
    ? Array.isArray(options.type)
      ? options.type
      : [options.type]
    : ["web"];

  const fetchPage = async (
    type: SearchResultType,
    page: number,
  ): Promise<any[]> => {
    const params = {
      q: q,
      language: searxngLanguage(options.lang, options.country),
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      // SEARXNG_ENGINES targets web engines; news/images use their category's engines.
      engines: type === "web" ? (config.SEARXNG_ENGINES ?? "") : "",
      categories:
        type === "web"
          ? (options.categories ?? config.SEARXNG_CATEGORIES ?? "")
          : type,
      pageno: page,
      format: "json",
      time_range: searxngTimeRange(options.tbs),
      // 2 = strict; omitted otherwise so the instance default applies
      ...(options.safe ? { safesearch: 2 } : {}),
    };

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;
    return data && Array.isArray(data.results)
      ? data.results.map(toResult[type])
      : [];
  };

  const fetchType = async (type: SearchResultType) => {
    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / resultsPerPage),
    );
    let results: any[] = [];
    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      const pageResults = await fetchPage(type, startPage + pageOffset);
      if (pageResults.length === 0) {
        break;
      }
      results = results.concat(pageResults);
      if (results.length >= requestedResults) {
        break;
      }
    }
    return results.slice(0, requestedResults);
  };

  if (requestedResults === 0) {
    return {};
  }

  // fork: one failing group (say, news) must not empty the others.
  const settled = await Promise.allSettled(types.map(fetchType));
  const response: SearchV2Response = {};
  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      logger.error(`There was an error searching for content`, {
        error: outcome.reason,
        type: types[i],
      });
    } else if (outcome.value.length > 0) {
      response[types[i]] = outcome.value;
    }
  });
  return response;
}

/**
 * fork: /v2/map discovers pages with a `site:` search that only Fire-engine
 * served. Map builds `site:<full url>`; search engines want `site:host/path`,
 * and some engines ignore the operator, so results are also filtered by host.
 */
export async function searxngMapResults(
  q: string,
  numResults: number,
): Promise<WebSearchResult[]> {
  const token = q.match(/site:(\S+)/)?.[1];
  const bare = token?.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const host = bare
    ?.split("/")[0]
    .replace(/^www\./i, "")
    .toLowerCase();
  const query = token && bare ? q.replace(token, bare) : q;
  const results =
    (await searxng_search(query, { num_results: numResults })).web ?? [];
  if (!host) return results;
  return results.filter(r => {
    try {
      const h = new URL(r.url).hostname.toLowerCase().replace(/^www\./, "");
      return h === host || h.endsWith("." + host);
    } catch {
      return false;
    }
  });
}

/**
 * fork: the developer and gov categories are served from Firecrawl Cloud's own
 * indexes. Without them, approximate with SearXNG: its code engines (GitHub,
 * Stack Overflow, MDN, PyPI, ...) for developer, and `.gov` web results for gov.
 */
export async function searxngCategoryFallback(
  category: "developer" | "gov",
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  if (!config.SEARXNG_ENDPOINT) return [];
  const results =
    category === "developer"
      ? (await searxng_search(query, { num_results: limit, categories: "it" }))
          .web
      : (
          await searxng_search(`${query} site:gov`, {
            num_results: limit * 3,
          })
        ).web?.filter(r => {
          try {
            return new URL(r.url).hostname.endsWith(".gov");
          } catch {
            return false;
          }
        });
  return (results ?? []).slice(0, limit).map((r, i) => ({
    ...r,
    position: i + 1,
    category,
  }));
}
