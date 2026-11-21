// fork: the only way out for browser sessions (PLAN.md Phase 14).
//
// browser-sessions sits on an internal Docker network with no route out; this
// proxy is on that network and on the normal one. It forwards HTTP and HTTPS
// (CONNECT) to public addresses only: every name is resolved here and refused
// if any address is private, loopback, link-local or Docker's host gateway, and
// the connection goes to the checked address (no DNS rebinding). So session
// code can reach the web, but not Redis, Postgres, the API, or anything on the
// Mac (stealth engine, Ollama) through host.docker.internal.
//
// It also relays CDP WebSockets from 127.0.0.1:9333 (published to the host
// only) to the session service, which checks each session's token.
const dns = require("node:dns/promises");
const http = require("node:http");
const net = require("node:net");

const PROXY_PORT = 3128;
const CDP_PORT = 9333;
const SESSIONS = { host: process.env.SESSIONS_HOST || "browser-sessions", port: 9222 };

const blocked = new net.BlockList();
for (const [range, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]])
  blocked.addSubnet(range, bits, "ipv6");

function isBlocked(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

/** A public address for host, or throws. */
async function publicAddress(host) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!name.includes(".") && !net.isIP(name)) throw new Error("bare host names are not allowed");
  if (name.endsWith(".internal") || name.endsWith(".local") || name === "localhost") throw new Error("internal name");
  const addresses = net.isIP(name) ? [{ address: name }] : await dns.lookup(name, { all: true });
  if (!addresses.length || addresses.some(a => isBlocked(a.address))) throw new Error("private address");
  return addresses[0].address;
}

const proxy = http.createServer(async (req, res) => {
  // Plain HTTP: the request line carries an absolute URL.
  let url;
  try {
    url = new URL(req.url);
    if (url.protocol !== "http:") throw new Error("only http here; https uses CONNECT");
    const address = await publicAddress(url.hostname);
    const upstream = http.request(
      { host: address, port: url.port || 80, method: req.method, path: url.pathname + url.search,
        headers: { ...req.headers, host: url.host }, setHost: false },
      up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  } catch (error) {
    res.writeHead(403, { "content-type": "text/plain" }).end(`egress refused: ${error.message}\n`);
  }
});

proxy.on("connect", async (req, socket, head) => {
  try {
    const [host, port = "443"] = req.url.split(/:(?=\d+$)/);
    const address = await publicAddress(host);
    const upstream = net.connect(Number(port), address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  } catch (error) {
    socket.end(`HTTP/1.1 403 Forbidden\r\n\r\negress refused: ${error.message}\n`);
  }
});

// CDP relay: pass the WebSocket upgrade through untouched; the session
// service checks /cdp/<session>/<token>.
const relay = http.createServer((_, res) => res.writeHead(426).end());
relay.on("upgrade", (req, socket, head) => {
  if (!/^\/cdp\/[\w-]+\/[\w-]+$/.test(req.url)) return socket.destroy();
  const upstream = net.connect(SESSIONS.port, SESSIONS.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

if (require.main === module) {
  proxy.listen(PROXY_PORT, () => console.log(`egress proxy on :${PROXY_PORT}`));
  relay.listen(CDP_PORT, () => console.log(`CDP relay on :${CDP_PORT}`));
}
module.exports = { isBlocked, publicAddress };
