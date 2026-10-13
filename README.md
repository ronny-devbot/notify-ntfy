# notify-ntfy

Minimal ntfy-only notification extension for pi. Auto-loaded from
`~/.pi/agent/extensions/` (no settings.json entry needed) — works in the
terminal TUI and in PI WEB, because it subscribes to pi's **built-in**
`ExtensionRunner` events rather than third-party broadcast contracts.

## What it notifies

| pi event | Notification |
|---|---|
| `ui_prompt_start` — any `ui.confirm` / `select` / `input` / `editor` / `custom` dialog opens (sandbox permission prompts, compaction confirm, …) | **Pi - needs your input** — `<session>: <kind>: <title>` |
| `agent_settled` — agent run has ended, session is idle (after retries, compaction, queued continuations) | **Pi - done** — `<session>: agent settled` — or **Pi - needs your input** when PI WEB's `ask_user` posted questions |

Known gaps (by design of pi core, not this plugin):
- PI WEB's built-in `ask_user` tool posts questions over its own WebSocket
  channel (no `ui_prompt_start`), but it runs through the normal tool
  pipeline and terminates the run — the extension detects a successful
  `ask_user` execution (`tool_execution_end`) and reports **Pi - needs your
  input** (check the browser) on settlement.
- The terminal trust dialog uses a separate unwrapped UI context → not
  emitted in TUI mode.

## Session links

With `piwebBaseUrl` set, every notification carries a tappable deep link to
the session in PI WEB (ntfy `Click` header, e.g.
`http://127.0.0.1:8504/?project=<id>&workspace=<id>&session=<id>`).

- `project` — the registered PI WEB project for the session's working
  directory (matched by path, or via the shared git repo for worktrees).
- `workspace` — first 12 hex of `sha1("<projectId>:<worktree-root>")`,
  exactly how the PI WEB server computes workspace ids.
- `session` — `PI_SESSION_ID`.

The session's working directory is taken from the session context: under
PI WEB's embedded session daemon `process.cwd()` is the daemon's home dir,
not the session's workspace. If no project can be resolved (e.g. the
session's directory was never added as a PI WEB project), the notification
is still sent, just without a link.

## Config

Config lives next to the extension (one file, co-located):

```
~/.pi/agent/extensions/notify-ntfy/config.json
{
  "enabled": true,
  "ntfyServerUrl": "https://ntfy.lan",
  "ntfyTopic": "all",
  "ntfyToken": null,
  "ntfyPriority": 3,
  "piwebBaseUrl": "http://127.0.0.1:8504"
}
```

Missing file or `enabled: false` → silent no-op. Edits take effect on the
next notification (config is read per event, no restart).

Override the config path: `PI_NTFY_CONFIG=/path/to/config.json` (used by the
self-test).

Code changes are different: extensions load at session start, so existing
PI WEB sessions need `/reload` (or a new session) to pick them up.

## Self-test

```
node test/selftest.ts
```

Posts against a local HTTP server; asserts request shape (headers, Click
link), event wiring, link resolution (plain dir, git repo, linked
worktree, subdirectory, no match), and the no-op paths.
