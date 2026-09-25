/**
 * notify-ntfy — minimal ntfy-only notification extension for pi.
 *
 * Subscribes to pi's built-in ExtensionRunner events (no third-party
 * broadcast contracts, no UI patching — works in TUI and pi-web alike):
 *
 *   ui_prompt_start  → some ui.confirm/select/input/editor/custom dialog is
 *                      being shown: the user must act.
 *   agent_settled    → the agent run is complete (settled after retries,
 *                      compaction, and queued continuations).
 *   agent_start + tool_execution_end → pi-web's ask_user tool (posts browser
 *                      questions, terminates the run, no ui_prompt_start) is
 *                      detected so settlement reports "needs your input".
 *
 * Config: co-located config file in this extension's directory:
 *   <extension-dir>/config.json   { enabled, ntfyServerUrl, ntfyTopic, ntfyToken,
 *                                   ntfyPriority, piwebBaseUrl }
 * Override the path with PI_NTFY_CONFIG (also used by the self-test).
 * Missing file or enabled:false → plugin is a silent no-op.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NtfyConfig {
  enabled?: boolean;
  ntfyServerUrl?: string;
  ntfyTopic?: string;
  ntfyToken?: string | null;
  ntfyPriority?: number;
  /** pi-web address (e.g. http://127.0.0.1:8504). Set to link notifications to this session. */
  piwebBaseUrl?: string;
}

// __dirname in CJS (jiti transform) or fileURLToPath in native ESM — pi's loader
// may use either depending on whether the .ts loads natively.
const extDir = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const defaultConfigPath = (): string => process.env.PI_NTFY_CONFIG ?? path.join(extDir, "config.json");

export function loadConfig(p: string = defaultConfigPath()): NtfyConfig | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as NtfyConfig;
  } catch {
    return null;
  }
}

/** git facts for dir in one bounded call; null if not inside a repo. A dead mount must not hang the agent. */
function gitInfo(dir: string, deadline: number): { top: string; common: string } | null {
  if (Date.now() > deadline) return null;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const lines = out.toString().trim().split("\n");
    const top = lines[0]?.trim() ?? "";
    const commonRaw = lines[1]?.trim() ?? "";
    if (!top || !commonRaw) return null;
    const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(dir, commonRaw);
    return { top, common };
  } catch {
    return null;
  }
}

/**
 * Deep link into pi-web for this session, e.g.
 *   http://127.0.0.1:8504/?project=<id>&workspace=<12-hex>&session=<uuid>
 *
 * Mirrors the server's workspace model: projectId is the registered project
 * (matched by path / git repo) and workspace id is sha1("<projectId>:<key>")
 * truncated to 12 hex, with key the git worktree root when the project is a
 * repo, else the project path. Returns null when it cannot be resolved.
 *
 * cwd must be the session's working directory, NOT process.cwd(): under
 * pi-web's embedded session daemon the agent runs inside the daemon process,
 * whose cwd is the daemon's home dir, not the session's workspace.
 */
export function sessionLink(piwebBaseUrl: string, cwd: string = process.cwd()): string | null {
  if (!piwebBaseUrl) return null;
  const workdir = path.resolve(cwd);
  const dataDir = process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".pi-web");
  let projects: { id: string; path: string }[] = [];
  try {
    projects = JSON.parse(readFileSync(path.join(dataDir, "projects.json"), "utf8")).projects ?? [];
  } catch {
    return null;
  }
  const deadline = Date.now() + 5000;
  const infos = new Map<string, { top: string; common: string } | null>();
  const info = (p: string) => {
    if (!infos.has(p)) infos.set(p, gitInfo(p, deadline));
    return infos.get(p)!;
  };
  const key = (p: { path: string }): string => info(p.path)?.top ?? p.path;
  // 1. registered project for this exact directory
  let proj = projects.find((p) => path.resolve(p.path) === workdir);
  let k = proj ? key(proj) : null;
  // 2. git worktree session: cwd is inside the repo of some registered project
  //    (linked worktrees share the git common dir, not the toplevel)
  const cwdInfo = info(workdir);
  if (!proj && cwdInfo)
    for (const p of projects)
      if (info(p.path)?.common === cwdInfo.common) {
        proj = p;
        k = cwdInfo.top;
        break;
      }
  // 3. session in a subdirectory of a registered project
  if (!proj) {
    proj = projects
      .filter((p) => workdir.startsWith(path.resolve(p.path) + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0];
    k = proj ? key(proj) : null;
  }
  if (!proj || !k) return null;
  const workspace = createHash("sha1").update(`${proj.id}:${k}`).digest("hex").slice(0, 12);
  const q = new URLSearchParams({ project: proj.id, workspace });
  const sid = process.env.PI_SESSION_ID ?? "";
  if (sid) q.set("session", sid);
  return `${piwebBaseUrl.replace(/\/+$/, "")}/?${q.toString()}`;
}

/** POST one notification to ntfy. Explicit opt-in (enabled:true). Throws on failure — callers catch. */
export async function postNtfy(cfg: NtfyConfig, title: string, message: string, link?: string): Promise<void> {
  if (cfg.enabled !== true) return;
  if (!cfg.ntfyServerUrl || !cfg.ntfyTopic) return;
  const headers: Record<string, string> = {
    Title: title,
    Priority: String(cfg.ntfyPriority ?? 3),
  };
  if (cfg.ntfyToken) headers.Authorization = `Bearer ${cfg.ntfyToken}`;
  if (link) headers.Click = link;
  await fetch(`${cfg.ntfyServerUrl.replace(/\/+$/, "")}/${cfg.ntfyTopic}`, {
    method: "POST",
    body: message,
    headers,
    signal: AbortSignal.timeout(5_000),
  });
}

function sessionName(pi: ExtensionAPI): string {
  try {
    return pi.getSessionName?.() ?? "";
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI): void {
  const notify = (title: string, message: string): void => {
    // Config read per notification: cheap, and edits apply without a restart.
    const cfg = loadConfig();
    if (!cfg) return;
    // Tappable link into pi-web via the ntfy Click header.
    const link = sessionLink(cfg.piwebBaseUrl ?? "", sessionCwd);
    postNtfy(cfg, title, message, link).catch(() => {
      /* fire-and-forget: a dead ntfy server must never block the agent */
    });
  };

  const name = () => sessionName(pi);
  const prefix = () => (name() ? `${name()}: ` : "");

  // pi-web's ask_user posts questions to the browser and terminates the run
  // without a ui_prompt_start; a successful execution in this run means the
  // browser is waiting. agent_start resets per run (answers wake a new run).
  let browserWaiting = false;

  // Session working directory: right as process.cwd() in TUI (the agent is
  // spawned in the workspace), but under pi-web's embedded session daemon the
  // runtime lives in the daemon process — take it from the session context.
  let sessionCwd = process.cwd();
  const trackCwd = (cwd?: string): void => {
    if (cwd) sessionCwd = path.resolve(cwd);
  };

  // Fires at session start and on /reload: the authoritative cwd refresh.
  pi.on("resources_discover", (e) => trackCwd(e.cwd));

  pi.on("agent_start", (e, ctx) => {
    trackCwd(ctx?.cwd);
    browserWaiting = false;
  });

  pi.on("tool_execution_end", (e) => {
    if (e.toolName === "ask_user" && !e.isError) browserWaiting = true;
  });

  pi.on("ui_prompt_start", (e, ctx) => {
    trackCwd(ctx?.cwd);
    const what = e.title ? `${e.kind}: ${e.title}` : `${e.kind} prompt`;
    // ASCII-only: HTTP headers are ByteStrings, fetch rejects non-Latin-1.
    notify("Pi - needs your input", `${prefix()}${what}`);
  });

  pi.on("agent_settled", (e, ctx) => {
    trackCwd(ctx?.cwd);
    notify(
      browserWaiting ? "Pi - needs your input" : "Pi - done",
      `${prefix()}${browserWaiting ? "questions posted - check the browser" : "agent run complete"}`,
    );
  });
}
