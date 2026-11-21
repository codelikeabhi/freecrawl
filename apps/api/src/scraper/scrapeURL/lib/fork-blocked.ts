// fork: blocked-page classifier (PLAN.md Phase 6). Upstream only escalates to
// stealth on 401/403/429; bot walls often answer 200 with a challenge page.
import { pacingOn } from "./fork-host-pace";

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

// Anywhere in the title: sites prefix their name ("Reddit - Prove your humanity").
const CHALLENGE_TITLES =
  /<title[^>]*>[^<]{0,60}?(just a moment\.\.\.|attention required!? \| cloudflare|access denied|pardon our interruption|are you a robot\??|are you a human\??|please verify you are a human|verify(?:ing)? you are human|prove your humanity|checking your browser|security check|robot check|unusual traffic|ddos-guard|one more step)/i;

const CHALLENGE_MARKERS: [RegExp, string][] = [
  [/challenges\.cloudflare\.com|cf-chl-|cf_chl_opt/i, "Cloudflare challenge"],
  [/captcha-delivery\.com|geo\.captcha-delivery/i, "DataDome challenge"],
  [/px-captcha|perimeterx|_pxCaptcha/i, "PerimeterX challenge"],
  [/_Incapsula_Resource|incap_ses_/i, "Imperva challenge"],
  [/hcaptcha\.com\/captcha|class="h-captcha"/i, "hCaptcha"],
  [/google\.com\/recaptcha\/(api2\/anchor|enterprise)/i, "reCAPTCHA"],
  [/ak_bmsc|_abck=|akamai bot manager/i, "Akamai challenge"],
];

/**
 * Why a page looks blocked, or undefined when it does not. `text` is the
 * page's visible text or markdown, when the caller has it.
 */
export function blockedReason(
  statusCode: number,
  html: string | undefined,
  text?: string,
): string | undefined {
  if (BLOCK_STATUSES.has(statusCode)) return `HTTP ${statusCode}`;
  const page = html ?? "";
  const title = CHALLENGE_TITLES.exec(page);
  if (title) return `challenge page ("${title[1].trim()}")`;
  // Markers alone also appear on normal pages that embed a CAPTCHA widget, so
  // only count them on short pages.
  if (page.length < 60000) {
    for (const [pattern, name] of CHALLENGE_MARKERS) {
      if (pattern.test(page)) return name;
    }
  }
  // ponytail: < 50 visible characters on a 200 page is almost always a wall
  // or a shell that never rendered; legit tiny pages are rare.
  // JSON-LD blocks are data, not a JavaScript app that failed to render.
  if (
    text !== undefined &&
    text.trim().length < 50 &&
    /<script(?![^>]*application\/ld\+json)/i.test(page)
  ) {
    return "almost no content";
  }
  return undefined;
}

// Pages that are not what was asked for, though no bot wall: stealth would
// not help, so these become a warning instead of an escalation.
// The title must start with the phrase (after an optional "Site - " prefix),
// so an article about HTTP 404 is not flagged.
const NOT_FOUND_TITLE =
  /<title[^>]*>\s*(?:[^<]{0,40}?\s[-|:–]\s*)?(?:404\b|page not found|not found|page (?:does not|doesn't) exist)/i;
const PASSWORD_INPUT = /<input[^>]+type\s*=\s*["']?password/i;

export function pageWarning(
  statusCode: number,
  html: string | undefined,
): string | undefined {
  if (statusCode === 429) {
    return pacingOn()
      ? "The site answered 429 Too Many Requests. Later requests to this host wait before they start (Retry-After, or a backoff of up to 60 s)."
      : "The site answered 429 Too Many Requests; wait before sending it more requests.";
  }
  if (!html || statusCode < 200 || statusCode >= 300) return undefined;
  if (NOT_FOUND_TITLE.test(html)) {
    return `This page looks like a "not found" page, although the server answered ${statusCode}.`;
  }
  // ponytail: a password field on a short page is a sign-in wall; long pages
  // often carry a login box in the header and still show their content.
  if (PASSWORD_INPUT.test(html) && html.length < 30000) {
    return "This page is mostly a sign-in form; the content may be behind a login.";
  }
  return undefined;
}
