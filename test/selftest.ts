/**
 * Self-test: `node test/selftest.ts`
 *
 * 1. postNtfy() posts title/priority/token/body correctly to a local server.
 * 2. The extension factory wires ui_prompt_start + agent_settled to ntfy
 *    posts using the config from PI_NTFY_CONFIG.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Captured {
  method?: string;
  url?: string;
  title?: string;
  priority?: string;
  auth?: string;
  click?: string;
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
      click: req.headers["click"] as string | undefined,
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
await postNtfy({ enabled: true, ntfyServerUrl: base, ntfyTopic: "all", ntfyToken: "sekret", ntfyPriority: 4 }, "T", "m");
assert.equal(received[0].method, "POST");
assert.equal(received[0].url, "/all");
assert.equal(received[0].title, "T");
assert.equal(received[0].priority, "4");
assert.equal(received[0].auth, "Bearer sekret");
assert.equal(received[0].body, "m");

// disabled / incomplete configs are no-ops
await postNtfy({ enabled: false, ntfyServerUrl: base, ntfyTopic: "all" }, "T", "m");
await postNtfy({ ntfyServerUrl: base, ntfyTopic: "all" }, "T", "m");
await postNtfy({ enabled: true, ntfyServerUrl: base }, "T", "m");
assert.equal(received.length, 1, "disabled/incomplete configs must not post");

// --- 2. factory wires pi events to ntfy via the config file ---------------
const dir = mkdtempSync(`${tmpdir()}/notify-ntfy-test-`);
const configPath = `${dir}/config.json`;
writeFileSync(configPath, JSON.stringify({ enabled: true, ntfyServerUrl: base, ntfyTopic: "all", ntfyPriority: 3 }));
process.env.PI_NTFY_CONFIG = configPath;

const factory = (await import("../index.ts")).default;
const handlers = new Map<string, (e: unknown, ctx?: unknown) => void>();
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
assert.equal(received[2].body, "test-session: agent settled");

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
assert.equal(received[4].body, "test-session: agent settled");

// no config file → silent no-op, no throw
process.env.PI_NTFY_CONFIG = `${dir}/does-not-exist.json`;
handlers.get("ui_prompt_start")!({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
await new Promise((r) => setTimeout(r, 50));
assert.equal(received.length, 5, "missing config must not post");

// --- 3. sessionLink resolves project/workspace/session like the server ----
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const dataDir = `${dir}/pi-web-data`;
mkdirSync(dataDir);
const linkBase = "http://127.0.0.1:9999/";
const sid = "11111111-2222-3333-4444-555555555555";
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_SESSION_ID = sid;
const { sessionLink } = await import("../index.ts");
const ws = (projectId: string, key: string) =>
  createHash("sha1").update(`${projectId}:${key}`).digest("hex").slice(0, 12);
const expectLink = (projectId: string, key: string, extra = "") =>
  `${linkBase}?project=${projectId}&workspace=${ws(projectId, key)}&session=${sid}${extra}`;

// Factory end-to-end under pi-web: the daemon process's cwd is NOT the
// session workspace, so the link must come from the session context (ctx.cwd).
// (Restore the config path clobbered by the missing-config check above; the
// config is read per notification, so editing it takes effect on the
// already-constructed instance without a restart.)
process.env.PI_NTFY_CONFIG = configPath;
writeFileSync(configPath, JSON.stringify({ enabled: true, ntfyServerUrl: base, ntfyTopic: "all", piwebBaseUrl: linkBase }));

const savedCwd = process.cwd();
try {
  // non-git project, session in the project directory
  const plain = `${dir}/plain`;
  mkdirSync(plain);
  writeFileSync(`${dataDir}/projects.json`, JSON.stringify({ projects: [{ id: "p-plain", path: plain }] }));
  process.chdir(plain);
  assert.equal(sessionLink(linkBase), expectLink("p-plain", plain));

  // git repo project: workspace key is the worktree root
  const repo = `${dir}/repo`;
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  const wt = `${dir}/worktree`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "wt", wt], { stdio: "ignore" });
  writeFileSync(
    `${dataDir}/projects.json`,
    JSON.stringify({ projects: [{ id: "p-repo", path: repo }, { id: "p-plain", path: plain }] }),
  );
  process.chdir(repo);
  assert.equal(sessionLink(linkBase), expectLink("p-repo", repo), "repo checkout links to main worktree");
  // session in a linked worktree: same project, workspace key = worktree path
  process.chdir(wt);
  assert.equal(sessionLink(linkBase), expectLink("p-repo", wt), "worktree session resolves via shared repo root");
  // subdirectory session of a non-git project: still that project
  const sub = `${plain}/sub`;
  mkdirSync(sub);
  process.chdir(sub);
  assert.equal(sessionLink(linkBase), expectLink("p-plain", plain), "subdir session resolves to enclosing project");
  // no project matches (e.g. plain directory outside any project)
  const nowhere = `${dir}/nowhere`;
  mkdirSync(nowhere);
  process.chdir(nowhere);
  assert.equal(sessionLink(linkBase), null);
} finally {
  process.chdir(savedCwd);
}

// ctx.cwd drives the link (pi-web: daemon cwd != session cwd). The config is
// read per notification, so adding piwebBaseUrl to the existing config takes effect
// on the already-constructed extension instance without a restart.
const plainPath = `${dir}/plain`;
handlers.get("ui_prompt_start")!({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Ctx cwd" }, { cwd: plainPath });
await new Promise((r) => setTimeout(r, 100));
assert.equal(received.length, 6);
const link = expectLink("p-plain", plainPath);
assert.equal(received[5].click, link, "Click header must use the session cwd from context");
assert.equal(received[5].body, "test-session: confirm: Ctx cwd", "message body must not carry the URL");

// no data dir / missing projects.json → null, no throw
process.env.PI_WEB_DATA_DIR = `${dir}/no-such-dir`;
assert.equal(sessionLink(linkBase), null);
// no piwebBaseUrl → null
writeFileSync(`${dataDir}/projects.json`, JSON.stringify({ projects: [] }));
process.env.PI_WEB_DATA_DIR = dataDir;
assert.equal(sessionLink(""), null);

// postNtfy with a link sets the Click header
received.length = 0;
await postNtfy({ enabled: true, ntfyServerUrl: base, ntfyTopic: "all" }, "T", "m", "http://x/?session=1");
assert.equal(received[0].click, "http://x/?session=1");
assert.equal(received.length, 1);

delete process.env.PI_WEB_DATA_DIR;

server.close();
console.log("notify-ntfy self-test: PASS");
