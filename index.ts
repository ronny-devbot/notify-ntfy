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
 *   <extension-dir>/config.json   { enabled, serverUrl, topic, token, priority }
 * Override the path with PI_NTFY_CONFIG (also used by the self-test).
 * Missing file or enabled:false → plugin is a silent no-op.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NtfyConfig {
  enabled?: boolean;
  serverUrl?: string;
  topic?: string;
  token?: string | null;
  priority?: number;
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

/** POST one notification to ntfy. Explicit opt-in (enabled:true). Throws on failure — callers catch. */
export async function postNtfy(cfg: NtfyConfig, title: string, message: string): Promise<void> {
  if (cfg.enabled !== true) return;
  if (!cfg.serverUrl || !cfg.topic) return;
  const headers: Record<string, string> = {
    Title: title,
    Priority: String(cfg.priority ?? 3),
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  await fetch(`${cfg.serverUrl.replace(/\/+$/, "")}/${cfg.topic}`, {
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
    postNtfy(cfg, title, message).catch(() => {
      /* fire-and-forget: a dead ntfy server must never block the agent */
    });
  };

  const name = () => sessionName(pi);
  const prefix = () => (name() ? `${name()}: ` : "");

  // pi-web's ask_user posts questions to the browser and terminates the run
  // without a ui_prompt_start; a successful execution in this run means the
  // browser is waiting. agent_start resets per run (answers wake a new run).
  let browserWaiting = false;

  pi.on("agent_start", () => {
    browserWaiting = false;
  });

  pi.on("tool_execution_end", (e) => {
    if (e.toolName === "ask_user" && !e.isError) browserWaiting = true;
  });

  pi.on("ui_prompt_start", (e) => {
    const what = e.title ? `${e.kind}: ${e.title}` : `${e.kind} prompt`;
    // ASCII-only: HTTP headers are ByteStrings, fetch rejects non-Latin-1.
    notify("Pi - needs your input", `${prefix()}${what}`);
  });

  pi.on("agent_settled", () => {
    notify(
      browserWaiting ? "Pi - needs your input" : "Pi - done",
      `${prefix()}${browserWaiting ? "questions posted - check the browser" : "agent run complete"}`,
    );
  });
}
