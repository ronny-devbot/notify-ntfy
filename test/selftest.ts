/**
 * Self-test: `node test/selftest.ts`
 *
 * 1. postNtfy() posts title/priority/token/body correctly to a local server.
 * 2. The extension factory wires ui_prompt_start + agent_settled to ntfy
 *    posts using the config from PI_NTFY_CONFIG.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Captured {
  method?: string;
  url?: string;
  title?: string;
  priority?: string;
  auth?: string;
  body: string;
}

const received: Captured[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({
      method: req.method,
      url: req.url,
      title: req.headers["title"] as string | undefined,
      priority: req.headers["priority"] as string | undefined,
      auth: req.headers["authorization"] as string | undefined,
      body,
    });
    res.end("ok");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// --- 1. postNtfy posts the right request shape ---------------------------
const { postNtfy } = await import("../index.ts");
await postNtfy({ enabled: true, serverUrl: base, topic: "all", token: "sekret", priority: 4 }, "T", "m");
assert.equal(received[0].method, "POST");
assert.equal(received[0].url, "/all");
assert.equal(received[0].title, "T");
assert.equal(received[0].priority, "4");
assert.equal(received[0].auth, "Bearer sekret");
assert.equal(received[0].body, "m");

// disabled / incomplete configs are no-ops
await postNtfy({ enabled: false, serverUrl: base, topic: "all" }, "T", "m");
await postNtfy({ serverUrl: base, topic: "all" }, "T", "m");
await postNtfy({ enabled: true, serverUrl: base }, "T", "m");
assert.equal(received.length, 1, "disabled/incomplete configs must not post");

// --- 2. factory wires pi events to ntfy via the config file ---------------
const dir = mkdtempSync(`${tmpdir()}/notify-ntfy-test-`);
const configPath = `${dir}/config.json`;
writeFileSync(configPath, JSON.stringify({ enabled: true, serverUrl: base, topic: "all", priority: 3 }));
process.env.PI_NTFY_CONFIG = configPath;

const factory = (await import("../index.ts")).default;
const handlers = new Map<string, (e: unknown) => void>();
const pi = {
  on: (event: string, handler: (e: unknown) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  getSessionName: () => "test-session",
  events: { emit: () => undefined, on: () => () => undefined },
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

factory(pi);
assert.ok(handlers.has("ui_prompt_start"), "must subscribe ui_prompt_start");
assert.ok(handlers.has("agent_settled"), "must subscribe agent_settled");

handlers.get("ui_prompt_start")!({
  type: "ui_prompt_start",
  reason: "ui_prompt",
  kind: "confirm",
  title: "Compact history?",
});
handlers.get("agent_settled")!({ type: "agent_settled" });
await new Promise((r) => setTimeout(r, 100)); // posts are fire-and-forget

assert.equal(received.length, 3);
assert.equal(received[1].title, "Pi - needs your input");
assert.equal(received[1].body, "test-session: confirm: Compact history?");
assert.equal(received[2].title, "Pi - done");
assert.equal(received[2].body, "test-session: agent run complete");

// pi-web ask_user: successful execution → settlement reports browser-waiting
handlers.get("agent_start")!({ type: "agent_start" });
handlers.get("tool_execution_end")!({
  type: "tool_execution_end",
  toolCallId: "x",
  toolName: "ask_user",
  isError: false,
  result: {},
});
handlers.get("agent_settled")!({ type: "agent_settled" });
await new Promise((r) => setTimeout(r, 100));
assert.equal(received.length, 4);
assert.equal(received[3].title, "Pi - needs your input");
assert.equal(received[3].body, "test-session: questions posted - check the browser");

// rejected ask (isError) then a plain tool → back to "Pi - done"
handlers.get("agent_start")!({ type: "agent_start" });
handlers.get("tool_execution_end")!({
  type: "tool_execution_end",
  toolCallId: "y",
  toolName: "ask_user",
  isError: true,
  result: {},
});
handlers.get("tool_execution_end")!({
  type: "tool_execution_end",
  toolCallId: "z",
  toolName: "bash",
  isError: false,
  result: {},
});
handlers.get("agent_settled")!({ type: "agent_settled" });
await new Promise((r) => setTimeout(r, 100));
assert.equal(received.length, 5);
assert.equal(received[4].title, "Pi - done");
assert.equal(received[4].body, "test-session: agent run complete");

// no config file → silent no-op, no throw
process.env.PI_NTFY_CONFIG = `${dir}/does-not-exist.json`;
handlers.get("ui_prompt_start")!({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
await new Promise((r) => setTimeout(r, 50));
assert.equal(received.length, 5, "missing config must not post");

server.close();
console.log("notify-ntfy self-test: PASS");
