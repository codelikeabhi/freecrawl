// fork: browser sessions speaking Hangar's contract (PLAN.md Phase 14).
//
// The API's client (apps/api/src/lib/hangar.ts) calls, over a Unix socket
// (FORK_HANGAR_SOCKET), since this container has no network path to the API:
//   POST   /v1/browsers               {owner, max_lifetime_seconds, idle_timeout_seconds,
//                                      profile?: {name, save_changes}, ...} -> browser + cdp_url
//   GET    /v1/browsers/:id           -> browser
//   POST   /v1/browsers/:id/stop      -> browser (stopped)
//   POST   /v1/browsers/:id/execute   {code, language: node|bash|python, timeout}
//                                      -> {stdout, result, stderr, exit_code, killed, truncated}
//   DELETE /v1/profiles/:name?owner=  -> {deleted_at}
// Times are epoch seconds. Each session is its own Chromium with one tab,
// going out only through egress-proxy. Node code runs with page/context/
// browser over CDP; bash gets agent-browser pointed at the session. No live
// view, recording or Python. CDP is relayed (token-checked) on port 9222 to
// egress-proxy, which publishes it on 127.0.0.1 only.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const SOCKET = process.env.HANGAR_SOCKET || "/sessions/hangar.sock";
const EGRESS = process.env.EGRESS_PROXY || "http://egress-proxy:3128";
const PUBLIC_CDP = process.env.PUBLIC_CDP_BASE || "ws://127.0.0.1:9333";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
const OUTPUT_LIMIT = 1024 * 1024;
const PROFILES = "/profiles";
const WORK = "/tmp/sessions";
const LOCKS = /^Singleton(Lock|Socket|Cookie)$/;

const sessions = new Map();
const byKey = new Map(); // Idempotency-Key -> session id
const writers = new Map(); // profile dir -> session id
const now = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const view = s => ({
  id: s.id, status: s.status, created_at: s.createdAt, ended_at: s.endedAt,
  max_expires_at: s.maxExpiresAt, recording: false, profile_saved_at: s.profileSavedAt ?? null,
  error: s.error ?? null,
});

const profileDir = (owner, name) =>
  path.join(PROFILES, crypto.createHash("sha256").update(`${owner}\0${name}`).digest("hex").slice(0, 32));

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function devtoolsPath(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return new URL((await res.json()).webSocketDebuggerUrl).pathname;
    } catch {}
    await sleep(100);
  }
  throw new HttpError(502, "browser did not start");
}

async function create(body, key) {
  if (key && byKey.has(key) && sessions.has(byKey.get(key))) return sessions.get(byKey.get(key));
  const running = [...sessions.values()].filter(s => s.status === "running").length;
  if (running >= MAX_SESSIONS) throw new HttpError(429, `at most ${MAX_SESSIONS} browser sessions at once`);

  const id = crypto.randomUUID();
  let userDataDir = path.join(WORK, id);
  let writerDir = null;
  if (body.profile?.name) {
    const dir = profileDir(body.owner ?? "", body.profile.name);
    if (body.profile.save_changes !== false) {
      if (writers.has(dir)) throw new HttpError(409, "another session is saving to this profile");
      fs.mkdirSync(dir, { recursive: true });
      writers.set(dir, id);
      userDataDir = writerDir = dir;
    } else if (fs.existsSync(dir)) {
      // A reader works on a copy: it sees the last saved state, changes are dropped.
      fs.cpSync(dir, userDataDir, { recursive: true, filter: src => !LOCKS.test(path.basename(src)) });
    }
    // Chromium's Singleton* links name the process that last held the profile;
    // left over (or copied), they make a new Chromium refuse to start.
    for (const name of fs.existsSync(userDataDir) ? fs.readdirSync(userDataDir) : []) {
      if (LOCKS.test(name)) fs.rmSync(path.join(userDataDir, name), { force: true });
    }
  }
  const port = await freePort();
  const proc = spawn(chromium.executablePath(), [
    `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", `--proxy-server=${EGRESS}`,
    "--window-size=1280,800", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  // The end of Chromium's stderr, so a failed start says why.
  let stderrTail = "";
  proc.stderr.on("data", chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });

  const s = {
    id, proc, port, token: crypto.randomBytes(24).toString("base64url"), status: "starting",
    createdAt: now(), endedAt: null, idleSeconds: Number(body.idle_timeout_seconds) || 300,
    maxExpiresAt: now() + (Number(body.max_lifetime_seconds) || 600), lastActivity: Date.now(),
    userDataDir, writerDir,
  };
  sessions.set(id, s);
  if (key) byKey.set(key, id);
  proc.on("exit", () => {
    if (s.status === "running" || s.status === "starting") finish(s, "failed", "browser exited");
  });
  // A failed start (EAGAIN at the process limit) must fail this session, not
  // crash the service: an unhandled child "error" event exits Node.
  proc.on("error", error => finish(s, "failed", `browser did not start: ${error.code ?? error.message}`));
  try {
    s.wsPath = await devtoolsPath(port);
  } catch (error) {
    await stop(s);
    console.error(`session ${id}: browser did not start\n${stderrTail}`);
    throw error;
  }
  s.status = "running";
  return s;
}

// The agent-browser daemon a bash execute starts outlives the call; end it
// with its session, or one stays behind per session.
function stopAgentDaemon(s) {
  const base = path.join("/tmp/ab", s.id.slice(0, 8));
  try {
    process.kill(Number(fs.readFileSync(`${base}.pid`, "utf8")), "SIGTERM");
  } catch {} // ponytail: no daemon (node-only session) or already gone
  for (const ext of [".pid", ".sock", ".config", ".stream", ".target", ".version"]) {
    fs.rmSync(base + ext, { force: true });
  }
}

function finish(s, status, error) {
  stopAgentDaemon(s);
  s.status = status;
  s.endedAt = s.endedAt ?? now();
  if (error) s.error = error;
  if (s.writerDir) {
    writers.delete(s.writerDir);
    s.profileSavedAt = now();
  } else {
    fs.rmSync(s.userDataDir, { recursive: true, force: true });
  }
  // Keep the record a while for status calls.
  setTimeout(() => sessions.delete(s.id), 3600_000).unref();
}

async function stop(s) {
  if (s.status === "stopped" || s.status === "failed" || s.status === "stopping") return s;
  s.status = "stopping";
  // A clean Browser.close flushes cookies and storage to a saved profile;
  // signals are the fallback.
  await new Promise(resolve => {
    if (!s.wsPath) return resolve();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}${s.wsPath}`);
    const done = setTimeout(resolve, 3000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onclose = ws.onerror = () => {
      clearTimeout(done);
      resolve();
    };
  });
  for (let i = 0; i < 50 && s.proc.exitCode === null && s.proc.signalCode === null; i++) await sleep(100);
  if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill("SIGTERM");
  for (let i = 0; i < 30 && s.proc.exitCode === null && s.proc.signalCode === null; i++) await sleep(100);
  if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill("SIGKILL");
  finish(s, "stopped");
  return s;
}

function execute(s, { code, language = "node", timeout = 30 }) {
  s.lastActivity = Date.now();
  if (language === "python") {
    return { stdout: "", result: "", stderr: "Python is not available in the local session service.", exit_code: 1, killed: false };
  }
  const env = {
    PATH: `/opt/fork/bin:${process.env.PATH}`, HOME: path.join(WORK, `${s.id}-home`),
    HTTP_PROXY: EGRESS, HTTPS_PROXY: EGRESS, http_proxy: EGRESS, https_proxy: EGRESS,
    // The session's own Chromium is on loopback; never send that via the proxy.
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    CDP_URL: `http://127.0.0.1:${s.port}`, AGENT_BROWSER_CDP: String(s.port),
    // agent-browser keeps a daemon socket per session name; keep the path short.
    AGENT_BROWSER_SESSION: s.id.slice(0, 8), AGENT_BROWSER_SOCKET_DIR: "/tmp/ab",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, NODE_PATH: "/app/node_modules",
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const child = language === "bash"
    ? spawn("bash", ["-c", code], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("node", [path.join(__dirname, "runner.js")], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  if (language !== "bash") child.stdin.end(code);
  const out = { stdout: "", stderr: "", result: "", truncated: false };
  const collect = name => chunk => {
    if (out[name].length >= OUTPUT_LIMIT) return void (out.truncated = true);
    out[name] += chunk.toString();
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  child.stdio[3]?.on("data", chunk => (out.result += chunk.toString()));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, Math.min(Number(timeout) || 30, 300) * 1000);
  return new Promise(resolve => {
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ stdout: "", result: "", stderr: `could not start: ${error.code ?? error.message}`,
        exit_code: 1, killed: false, truncated: false });
    });
    child.on("close", status => {
      clearTimeout(timer);
      s.lastActivity = Date.now();
      resolve({ stdout: out.stdout, result: out.result.slice(0, OUTPUT_LIMIT), stderr: out.stderr,
        exit_code: killed ? 137 : (status ?? 1), killed, truncated: out.truncated });
    });
  });
}

// Lifetime and idle limits.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.status !== "running") continue;
    if (now() >= s.maxExpiresAt || Date.now() - s.lastActivity > s.idleSeconds * 1000) stop(s);
  }
}, 5000).unref();

function readJson(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const api = http.createServer(async (req, res) => {
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    const url = new URL(req.url, "http://local");
    const parts = url.pathname.split("/").filter(Boolean); // v1, browsers|profiles, id, action
    if (parts[0] !== "v1") throw new HttpError(404, "not found");
    if (parts[1] === "profiles" && req.method === "DELETE" && parts[2]) {
      const dir = profileDir(url.searchParams.get("owner") ?? "", decodeURIComponent(parts[2]));
      if (writers.has(dir)) throw new HttpError(409, "a session is saving to this profile");
      fs.rmSync(dir, { recursive: true, force: true });
      return send(200, { deleted_at: now() });
    }
    if (parts[1] !== "browsers") throw new HttpError(404, "not found");
    if (req.method === "POST" && parts.length === 2) {
      const s = await create(await readJson(req), req.headers["idempotency-key"]);
      return send(200, { ...view(s), cdp_url: `${PUBLIC_CDP}/cdp/${s.id}/${s.token}` });
    }
    const s = sessions.get(parts[2]);
    if (!s) throw new HttpError(404, "unknown browser");
    if (req.method === "GET" && parts.length === 3) return send(200, view(s));
    if (req.method === "POST" && parts[3] === "stop") return send(200, view(await stop(s)));
    if (req.method === "POST" && parts[3] === "execute") {
      if (s.status !== "running") throw new HttpError(409, "browser is not running");
      return send(200, await execute(s, await readJson(req)));
    }
    throw new HttpError(404, "not found");
  } catch (error) {
    send(error.status || 500, { error: error.message });
  }
});

// CDP relay target: /cdp/<id>/<token> -> that session's Chromium.
const cdp = http.createServer((_, res) => res.writeHead(426).end());
cdp.on("upgrade", (req, socket, head) => {
  const [, , id, token] = req.url.split("/");
  const s = sessions.get(id);
  const ok = s && s.status === "running" && token &&
    token.length === s.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.token));
  if (!ok) return socket.destroy();
  const upstream = net.connect(s.port, "127.0.0.1", () => {
    const lines = [`GET ${s.wsPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (name === "host" || name === "origin") continue; // Chromium checks both
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: 127.0.0.1:${s.port}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const touch = () => (s.lastActivity = Date.now());
  socket.on("data", touch);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

fs.rmSync(SOCKET, { force: true });
api.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o666); // the API container runs as another user
  console.log(`session API on ${SOCKET}`);
});
cdp.listen(9222, "0.0.0.0", () => console.log("CDP relay target on :9222"));
