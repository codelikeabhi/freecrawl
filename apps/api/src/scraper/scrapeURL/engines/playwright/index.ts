import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { ActionError } from "../../error";
import { storeDataUrl } from "../../../../lib/fork-files";

// fork: Cloud's location picks a geo proxy; here only the browser language
// changes. ponytail: languages[0], else English for the country.
function browserLocale(location: Meta["options"]["location"]) {
  if (!location) return undefined;
  return (
    location.languages?.[0] ??
    (location.country ? `en-${location.country.toUpperCase()}` : undefined)
  );
}

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const locale = browserLocale(meta.options.location);
  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      screenshot: hasFormatOfType(meta.options.formats, "screenshot"),
      actions: meta.options.actions,
      mobile: meta.options.mobile,
      locale,
      block_ads: meta.options.blockAds !== false,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      // Optional: older playwright-service builds don't send it.
      url: z.string().optional(),
      screenshot: z.string().optional(),
      actions: z
        .object({
          screenshots: z.array(z.string()),
          scrapes: z.array(z.object({ url: z.string(), html: z.string() })),
          javascriptReturns: z.array(
            z.object({ type: z.string(), value: z.unknown() }),
          ),
          pdfs: z.array(z.string()).optional(),
        })
        .optional(),
      actionError: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  if (response.actionError) {
    throw new ActionError(response.actionError);
  }

  // fork: store images and PDFs as files when the files service is set up.
  const localFiles: string[] = [];
  const store = async (dataUrl: string) => {
    const { url, hostPath } = await storeDataUrl(dataUrl);
    if (hostPath) localFiles.push(hostPath);
    return url;
  };
  const screenshot = response.screenshot
    ? await store(response.screenshot)
    : undefined;
  const actions = response.actions && {
    screenshots: await Promise.all(response.actions.screenshots.map(store)),
    scrapes: response.actions.scrapes,
    javascriptReturns: response.actions.javascriptReturns.map(x => ({
      type: x.type,
      value: x.value,
    })),
    pdfs: await Promise.all((response.actions.pdfs ?? []).map(store)),
  };

  return {
    // The landed URL reported by the service. Redirect threat and blocklist
    // re-checks compare it against the requested URL. Falls back to the
    // requested URL for older services or a non-http(s) value (about:blank).
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    screenshot,
    ...(actions && { actions }),
    ...(localFiles.length ? { localFiles } : {}),
    ...(locale && {
      warning: `location: the browser language is set to ${locale}, but the request still comes from this machine's IP address (no geo proxy is configured).`,
    }),

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  return (
    (meta.options.waitFor ?? 0) +
    (meta.options.actions?.reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 2500) + a : 250 + a),
      0,
    ) ?? 0) +
    30000
  );
}
