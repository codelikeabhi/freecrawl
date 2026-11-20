// fork: code sandbox speaking the API's deterministicJson protocol
// (apps/api/src/scraper/scrapeURL/transformers/deterministicJson.ts):
//   client -> {type:"run", code, input}       code = the API's harness
//   server -> {type:"host", id, channel, payload}   askLlm calls, any number
//   client -> {type:"hostResult", id, value, error?}
//   server -> {type:"result", value} | {type:"error", message}
// Each run gets a fresh child process under Node's permission model (no
// spawning, no file writes, no workers), killed after 120 s. The container has
// no network at all; this server listens on a Unix socket only.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { fork } = require("node:child_process");
const { WebSocketServer } = require("ws");

const SOCKET = process.env.SANDBOX_SOCKET || "/sandbox/run.sock";
const TIMEOUT_MS = 120_000;

fs.rmSync(SOCKET, { force: true });
const server = http.createServer((_, res) => res.writeHead(426).end());
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 * 1024 });

wss.on("connection", ws => {
  let child = null;
  let done = false;
  const timer = setTimeout(() => finish({ type: "error", message: "sandbox timeout (120 s)" }), TIMEOUT_MS);
  function finish(message) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      ws.send(JSON.stringify(message));
      ws.close();
    } catch {}
    child?.kill("SIGKILL");
  }
  ws.on("message", data => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "run" && !child) {
      child = fork(path.join(__dirname, "runner.js"), [], {
        execArgv: ["--permission", "--allow-fs-read=*", "--max-old-space-size=512"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      child.on("message", m => (m.type === "host" ? ws.send(JSON.stringify(m)) : finish(m)));
      child.on("exit", code => finish({ type: "error", message: `sandbox process exited (${code})` }));
      child.send({ type: "run", code: msg.code, input: msg.input });
    } else if (msg.type === "hostResult" && child) {
      child.send(msg);
    }
  });
  ws.on("close", () => {
    done = true;
    clearTimeout(timer);
    child?.kill("SIGKILL");
  });
});

server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o666); // the API container runs as another user
  console.log(`code sandbox listening on ${SOCKET}`);
});
