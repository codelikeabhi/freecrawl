import { scrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import { useFireEngine } from "../scraper/scrapeURL/engines/fire-engine/available";
import { CostTracking } from "./cost-tracking";

/**
 * fork: /v2/map finds pages through the sitemap, Fire-engine search and the
 * index. Self-hosted has neither of the last two, so a site without a sitemap
 * maps to nothing whenever SearXNG's `site:` search comes back empty (engines
 * rate-limit). Add the links on the start page itself, as a last resort.
 * Map's own same-domain, path and dedupe filters run afterwards.
 */
export async function startPageLinks(
  mapId: string,
  url: string,
  opts: { teamId: string; orgId?: string | null; zeroDataRetention: boolean },
): Promise<{ url: string }[]> {
  if (useFireEngine) return [];
  try {
    const res = await scrapeURL(
      "map-links;" + mapId,
      url,
      scrapeOptions.parse({ formats: ["links"], onlyMainContent: false }),
      {
        teamId: opts.teamId,
        orgId: opts.orgId ?? null,
        zeroDataRetention: opts.zeroDataRetention,
      },
      new CostTracking(),
    );
    return res.success ? (res.document.links ?? []).map(u => ({ url: u })) : [];
  } catch {
    // ponytail: a failed start page just means no extra links; map still answers.
    return [];
  }
}
