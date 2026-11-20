// fork: blocked-page classifier (PLAN.md Phase 6). Upstream only escalates to
// stealth on 401/403/429; bot walls often answer 200 with a challenge page.

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

const CHALLENGE_TITLES =
  /<title[^>]*>\s*(just a moment\.\.\.|attention required!? \| cloudflare|access denied|pardon our interruption|are you a robot\??|please verify you are a human|verifying you are human|security check|ddos-guard|one more step)/i;

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
  if (text !== undefined && text.trim().length < 50 && /<script/i.test(page)) {
    return "almost no content";
  }
  return undefined;
}
