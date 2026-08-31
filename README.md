# wire-grok

Grok adapter for The Wire. One package, two process layers.

1. **Sidecar (parent).** Holds the one Wire SSE and injects turns via `grok agent stdio` ACP `session/prompt`. Analog of `codex-wire`. `grok-personai.sh` execs `src/index.ts`. This is inbound. It is not an MCP server.
2. **Plugin (inside Grok).** Skills + MCP tools (`set_plan`, `heartbeat_*`, `register_agent`). **No in-process SSE** — that would dual-connect against the sidecar. Outbound `send_message` is [wire-ipc](https://github.com/agiterra/wire-ipc-claude-code) (always a separate plugin).

Orchestrators install `bridge-grok` instead, which replaces crew + this wire *plugin* surface and will depend on the same sidecar implementation. Non-orchestrators install this.

Folded from `grok-wire-bridge` (Tim 590556). Live personae still exec the old path until a confirmed relaunch.

```
grok plugin install /Users/tim/Projects/Agiterra/wire-grok --trust
```
