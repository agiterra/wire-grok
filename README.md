# wire-grok

Grok adapter for The Wire. One package, two process layers.

1. **Sidecar (parent).** Holds the one Wire SSE and injects turns via `grok agent stdio` ACP `session/prompt`. Analog of `codex-wire`. `grok-personai.sh` execs `src/index.ts`. This is inbound. It is not an MCP server.
2. **Plugin (inside Grok).** Skills + MCP tools (`set_plan`, `heartbeat_*`, `register_agent`). **No in-process SSE** — that would dual-connect against the sidecar. Outbound `send_message` is [wire-ipc](https://github.com/agiterra/wire-ipc-claude-code) (always a separate plugin).

Orchestrators install `bridge-grok` instead, which replaces crew + this wire *plugin* surface and will depend on the same sidecar implementation. Non-orchestrators install this.

Folded from `grok-wire-bridge` (Tim 590556). Live personae still exec the old path until a confirmed relaunch.

```
grok plugin install /Users/tim/Projects/Agiterra/wire-grok --trust
```

## Wire signing key in Grok lanes

The sidecar needs `AGENT_PRIVATE_KEY` to sign Wire requests. `grok-acp.ts`
removes that variable from the Grok child process environment before spawn.
`grok-bridge-launch.sh` also excludes it from Grok shell tool environments.
The launcher provides the key to Wire and other signing MCP servers through
their per-server config entries. A lane's `config.toml` remains credential
material and must stay private to its operating-system user.

After a key rotation, do not reuse a stopped lane's `config.toml`. Sponsor-register
the lane with `force_rotate: true` during its next spawn and pass the returned
private key to the launcher.
