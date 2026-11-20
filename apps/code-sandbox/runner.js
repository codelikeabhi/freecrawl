// fork: one sandbox run (see server.js). Started with --permission, so it
// cannot spawn processes, write files or start workers.
const allowed = { jsdom: require("jsdom"), "node:vm": require("node:vm") };
const sandboxRequire = name => {
  if (!Object.hasOwn(allowed, name)) throw new Error(`module not allowed: ${name}`);
  return allowed[name];
};

const pending = new Map();
let nextId = 0;
const host = (channel, payload) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    process.send({ type: "host", id, channel, payload });
  });

process.on("message", async msg => {
  if (msg.type === "hostResult") {
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    msg.error ? call.reject(new Error(msg.error)) : call.resolve(msg.value);
    return;
  }
  if (msg.type !== "run") return;
  let reply;
  try {
    const AsyncFunction = (async () => {}).constructor;
    const value = await new AsyncFunction("input", "host", "require", msg.code)(msg.input, host, sandboxRequire);
    reply = { type: "result", value };
  } catch (error) {
    reply = { type: "error", message: String((error && error.message) || error).slice(0, 2000) };
  }
  process.send(reply, () => process.exit(0));
});
