// fork: the egress filter is the sandbox's wall; run `node check.js`.
const assert = require("node:assert");
const { isBlocked, publicAddress } = require("./server");

for (const ip of ["10.1.2.3", "192.168.65.254", "127.0.0.1", "172.17.0.1", "169.254.169.254",
  "100.64.1.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fd00::1", "fe80::1"])
  assert.ok(isBlocked(ip), `${ip} must be blocked`);
for (const ip of ["93.184.216.34", "142.250.72.14", "2606:4700::6810:85e5"])
  assert.ok(!isBlocked(ip), `${ip} must be allowed`);

(async () => {
  for (const host of ["localhost", "host.docker.internal", "redis", "127.0.0.1", "[::1]", "10.0.0.5", "foo.local"])
    await assert.rejects(publicAddress(host), `${host} must be refused`);
  console.log("egress filter: ok");
})();
