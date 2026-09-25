# notify-ntfy

Minimal ntfy-only notification extension for pi. Auto-loaded from
`~/.pi/agent/extensions/` (no settings.json entry needed) — works in the
terminal TUI and in pi-web, because it subscribes to pi's **built-in**
`ExtensionRunner` events rather than third-party broadcast contracts.

## What it notifies

| pi event | Notification |
|---|---|
| `ui_prompt_start` — any `ui.confirm` / `select` / `input` / `editor` / `custom` dialog opens (sandbox permission prompts, compaction confirm, …) | **Pi - needs your input** — `<session>: <kind>: <title>` |
| `agent_settled` — agent run fully complete (after retries, compaction, queued continuations) | **Pi - done** — `<session>: agent run complete` |

Known gaps (by design of pi core, not this plugin):
- pi-web's built-in `ask_user` tool uses its own WebSocket channel (no
  `ui_prompt_start`), but it terminates the run → you get "Pi — done",
  which means "check the question in your browser".
- The terminal trust dialog uses a separate unwrapped UI context → not
  emitted in TUI mode.

## Config

Config lives next to the extension (one file, co-located):

```
~/.pi/agent/extensions/notify-ntfy/config.json
{ "enabled": true, "serverUrl": "https://ntfy.lan", "topic": "all", "token": null, "priority": 3 }
```

Missing file or `enabled: false` → silent no-op. Edit takes effect on the
next notification (config is read per event, no restart).

Override the config path: `PI_NTFY_CONFIG=/path/to/config.json` (used by the
self-test).

## Self-test

```
node test/selftest.ts
```

Posts against a local HTTP server; asserts request shape, event wiring,
and the no-op paths.
