/**
 * GrokAcpClient — thin JSON-RPC 2.0 client over a `grok agent stdio` child,
 * the grok analog of codex-wire-bridge's CodexAppServer. One child per bridge
 * process, one ACP session per agent (v0).
 *
 * Grok speaks ACP (Agent Client Protocol) over newline-delimited JSON on stdio.
 * The shapes below were VERIFIED against grok 0.2.106 `agent stdio` (probe
 * 2026-07-20), not guessed:
 *
 *   initialize {protocolVersion:1, clientCapabilities} -> {protocolVersion,
 *       agentCapabilities:{loadSession:true,...}, authMethods:[cached_token,...]}
 *   session/new {cwd, mcpServers:[]} -> {sessionId, models:{currentModelId,...}}
 *       (auto-loads the wire-ipc MCP declared in ~/.grok/config.toml)
 *   session/load {sessionId, cwd, mcpServers} -> resume (agentCapabilities.loadSession)
 *   session/prompt {sessionId, prompt:[{type:"text",text}]} -> streams
 *       session/update notifications (agent_thought_chunk / agent_message_chunk /
 *       user_message_chunk / available_commands_update), then the REQUEST ITSELF
 *       RESOLVES at turn completion with {stopReason, _meta:{usage:{inputTokens,
 *       outputTokens,totalTokens,cachedReadTokens,reasoningTokens,modelCalls,
 *       costUsdTicks,...}}}.  <-- completion + token usage + cost, for free.
 *
 * THE KEY ADAPTATION vs codex: codex `turn/start` returns a turnId immediately
 * and completion arrives later as a `turn/completed` NOTIFICATION; grok
 * `session/prompt` is a request that RESOLVES at completion. So startTurn()
 * fires session/prompt WITHOUT awaiting it, returns a synthetic turnId
 * immediately (the gate only uses it for logging + the steer guard), and on
 * resolution synthesizes the `turn/completed` callback index.ts expects. The
 * TurnGate already serializes to one turn at a time, so we never overlap prompts.
 *
 * Grok's own bookkeeping notifications are all namespaced `_x.ai/*` — ignore
 * them (turn completion is taken from the prompt response, not the duplicate
 * `_x.ai/session_notification` turn_completed).
 *
 * Server->client REQUESTS: grok may send `session/request_permission` mid-turn.
 * Unlike codex (which refuses every server request), we AUTO-GRANT it — a
 * bridged agent runs bypassPermissions, and refusing would stall its tool use.
 */

import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";

type Json = Record<string, unknown>;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void };

function pluginDirsFromEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(":").map((s) => s.trim()).filter(Boolean);
}

/** `grok agent [flags] stdio` — flags MUST precede the subcommand. */
export function buildGrokAgentStdioArgs(opts: {
  model?: string;
  effort?: string;
  alwaysApprove?: boolean;
  noLeader?: boolean;
  pluginDirs?: string[];
}): string[] {
  const args = ["agent"];
  if (opts.alwaysApprove !== false) args.push("--always-approve");
  // --plugin-dir is ignored in leader mode. Personai is a dedicated ACP
  // child; a shared leader would drop Agiterra plugin hooks (KX).
  if (opts.noLeader !== false) args.push("--no-leader");
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("--reasoning-effort", opts.effort);
  for (const dir of opts.pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }
  args.push("stdio");
  return args;
}

export type GrokAcpOptions = {
  /** Working directory for the grok ACP session (the agent's project dir). */
  cwd: string;
  /** Model id (default grok-4.5). Passed to session/new when supported. */
  model?: string;
  /** Path to the grok binary (default: GROK_BIN env or "grok" on PATH). */
  grokBin?: string;
  onNotification?: (method: string, params: Json) => void;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Json) => void;
};

export class GrokAcpClient {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private opts: GrokAcpOptions;
  private turnCounter = 1;
  private loadSession = false;

  constructor(opts: GrokAcpOptions) {
    this.opts = opts;
  }

  private log(level: "info" | "warn" | "error", msg: string, fields?: Json) {
    this.opts.log?.(level, msg, fields);
  }

  async start(): Promise<void> {
    const bin = this.opts.grokBin ?? process.env.GROK_BIN ?? "grok";
    // Flags belong on `grok agent`, BEFORE the `stdio` subcommand.
    // `["agent","stdio"]` with no flags was the personai boot miss: no
    // --always-approve, no model pin, no effort. Grok then sat in default
    // permission mode and dropped MCP tool calls on the confirm prompt.
    const args = buildGrokAgentStdioArgs({
      model: this.opts.model ?? process.env.GROK_MODEL,
      effort: process.env.GROK_REASONING_EFFORT ?? process.env.GROK_EFFORT,
      alwaysApprove: process.env.GROK_ACP_ALWAYS_APPROVE !== "0",
      noLeader: process.env.GROK_ACP_NO_LEADER !== "0",
      pluginDirs: pluginDirsFromEnv(process.env.GROK_PLUGIN_DIRS),
    });
    this.log("info", "spawning grok agent stdio", { bin, args });
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: this.opts.cwd,
      env: process.env,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", (code: number | null) => {
      this.log("error", "grok agent stdio exited", { code });
      for (const [, p] of this.pending) p.reject(new Error(`grok agent exited (code ${code})`));
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const caps = (init.agentCapabilities ?? {}) as Json;
    this.loadSession = caps.loadSession === true;
    this.log("info", "grok ACP initialized", { loadSession: this.loadSession });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        this.log("warn", "unparseable line from grok", { line: line.slice(0, 200) });
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json): void {
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    if (id != null && method == null) {
      // Response to one of our requests.
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(`grok error: ${JSON.stringify(msg.error)}`));
      else p.resolve((msg.result ?? {}) as Json);
      return;
    }

    if (id != null && method != null) {
      // Server->client REQUEST — must answer or grok stalls.
      if (method.includes("request_permission") || method.endsWith("/permission")) {
        this.grantPermission(id, (msg.params ?? {}) as Json);
        return;
      }
      this.log("error", "unhandled grok server request — refusing", { method });
      this.send({ id, error: { code: -32601, message: `grok-wire-bridge does not handle ${method}` } });
      return;
    }

    if (method != null) {
      // Notification. Grok's own bookkeeping is _x.ai/*; ignore it (completion
      // is taken from the session/prompt response, not the duplicate
      // _x.ai/session_notification turn_completed). Forward anything else.
      if (method.startsWith("_x.ai/")) return;
      this.opts.onNotification?.(method, (msg.params ?? {}) as Json);
    }
  }

  /** Auto-grant a session/request_permission by selecting an allow-shaped option. */
  private grantPermission(id: number, params: Json): void {
    const opts = (params.options ?? params.permissionOptions ?? []) as Array<Json>;
    const allow =
      opts.find((o) => /allow|approve|grant|yes/i.test(JSON.stringify(o))) ?? opts[0];
    const optionId = (allow?.optionId ?? allow?.id) as string | undefined;
    this.log("info", "auto-granting grok permission request", { optionId });
    this.send({ id, result: { outcome: { outcome: "selected", optionId } } });
  }

  private send(msg: Json): void {
    if (!this.child) throw new Error("grok agent not started");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Json): void {
    this.send({ method, ...(params ? { params } : {}) });
  }

  // --- Session/turn helpers (mirror CodexAppServer's thread/turn API) ---

  /** Resume a persisted ACP session or start a fresh one. Returns the sessionId. */
  async ensureThread(persistedSessionId: string | null): Promise<{ threadId: string; resumed: boolean }> {
    if (persistedSessionId && this.loadSession) {
      try {
        await this.request("session/load", {
          sessionId: persistedSessionId,
          cwd: this.opts.cwd,
          mcpServers: [],
        });
        this.log("info", "grok session resumed", { sessionId: persistedSessionId });
        return { threadId: persistedSessionId, resumed: true };
      } catch (e) {
        this.log("warn", "session/load failed — starting fresh", { err: String(e) });
      }
    }
    const r = await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] });
    const sessionId = (r.sessionId ?? (r.session as Json | undefined)?.sessionId ?? r.id) as string | undefined;
    if (!sessionId) throw new Error(`session/new returned no sessionId: ${JSON.stringify(r)}`);
    this.log("info", "grok session started", { sessionId, model: (r.models as Json | undefined)?.currentModelId });
    return { threadId: sessionId, resumed: false };
  }

  /**
   * Fire a prompt turn. Returns a synthetic turnId IMMEDIATELY (grok's
   * session/prompt resolves only at completion, so we can't block here). On
   * resolution we synthesize the `turn/completed` notification index.ts expects,
   * carrying grok's stopReason + token usage.
   */
  startTurn(sessionId: string, text: string): Promise<string> {
    const turnId = String(this.turnCounter++);
    this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })
      .then((r) => {
        const meta = (r._meta ?? {}) as Json;
        this.opts.onNotification?.("turn/completed", {
          turn: { id: turnId, status: r.stopReason ?? "end_turn", usage: meta.usage ?? null },
        });
      })
      .catch((e) => {
        this.log("error", "session/prompt failed", { turnId, err: String(e) });
        this.opts.onNotification?.("turn/completed", { turn: { id: turnId, status: "error" } });
      });
    // Resolve synchronously-ish so the gate marks the turn in-flight immediately.
    return Promise.resolve(turnId);
  }

  /**
   * Grok has no documented mid-turn steer (it queues successive prompts). v0
   * throws so the bridge's gate falls back to queueing the event and pumping it
   * as the next turn on completion — which, given grok's prompt queue, is the
   * same net behavior.
   */
  async steerTurn(_sessionId: string, _expectedTurnId: string, _text: string): Promise<string> {
    throw new Error("grok ACP: mid-turn steer unsupported (v0) — queue as next turn");
  }
}
