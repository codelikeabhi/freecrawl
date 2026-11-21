// fork: runs one `node` execute call against a session (see server.js), like
// Hangar: Playwright globals `page`, `context`, `browser`; console output is
// stdout; the value of a single expression (or a `return`) is the result,
// written to fd 3. `page` starts as the visible tab and can be reassigned.
const fs = require("node:fs");
const { chromium } = require("playwright");

(async () => {
  const code = fs.readFileSync(0, "utf8");
  const browser = await chromium.connectOverCDP(process.env.CDP_URL);
  const context = browser.contexts()[0];
  const pages = context.pages().filter(p => !p.url().startsWith("chrome-extension://"));
  const page = pages[0] ?? (await context.newPage());
  const AsyncFunction = (async () => {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction("page", "context", "browser", `return (${code}\n);`);
  } catch {
    fn = new AsyncFunction("page", "context", "browser", code);
  }
  const value = await fn(page, context, browser);
  let result = "";
  if (typeof value === "string") result = value;
  else if (value !== undefined) {
    try {
      result = JSON.stringify(value);
    } catch {
      result = String(value);
    }
  }
  fs.writeSync(3, result);
  // Leave the browser running: exiting drops the CDP connection only.
  process.exit(0);
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
