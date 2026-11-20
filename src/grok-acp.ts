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
import type { TurnTimeoutConfig } from "./turn-timeout.js";

/** Keep the Wire signing key in the sidecar, outside the Grok child and its shell tools. */
export function grokChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.AGENT_PRIVATE_KEY;
  return childEnv;
}

type Json = Record<string, unknown>;

/**
 * 0.2.0: which ACP agent the sidecar drives. "grok" (`grok agent stdio`, the original) or "antigravity"
 * (Google's `agy acp`, Gemini 4 Neon; Tim 2026-11-20). Both speak the same ACP; the differences are argv,
 * how the model is pinned, how MCP servers reach the agent, and where sub-agent activity lands on disk.
 * VERIFIED against agy 1.5.13 (probes 2026-11-20, as _ephemeral):
 *   - `agy acp` takes NO --model/--effort. The model (effort is part of the id: gemini-4-neon-{low,medium,high,xhigh})
 *     is pinned in-protocol with session/set_model {sessionId, modelId}; an unknown id is REFUSED (-32602
 *     "Unknown model ID"), so a {} answer is the proof the pin took.
 *   - session/new|load.mcpServers [{name, command, args, env:[{name,value}]}] ARE spawned, env included.
 *   - session/prompt resolves {stopReason, usage:{inputTokens,outputTokens,cachedReadTokens,thoughtTokens,totalTokens}}
 *     (top-level usage, not grok's _meta.usage); session/update usage_update {used, size} is context occupancy.
 *   - An unverified Google account answers every model call 403 "Verify your account to continue", and agy
 *     reports it as a NORMAL end_turn whose only output is "⚠ Verification Required". Unhandled, a lane would
 *     look idle-but-healthy forever; the client turns it into status "auth_required".
 */
export type AcpAgentKind = "grok" | "antigravity";

export function acpAgentFromEnv(env: NodeJS.ProcessEnv): AcpAgentKind {
  const v = (env.ACP_AGENT ?? "grok").trim().toLowerCase();
  if (v === "grok" || v === "antigravity") return v;
  if (v === "agy") return "antigravity";
  throw new Error(`ACP_AGENT=${env.ACP_AGENT} is not a known ACP agent (grok | antigravity)`);
}

/** `agy acp [flags]`. --gemini-dir gives a lane its own token copy, conversations and logs. */
export function buildAgyAcpArgs(opts: { geminiDir?: string; addDirs?: string[]; skipPermissions?: boolean }): string[] {
  const args = ["acp"];
  // A bridged agent has no human to answer a permission prompt (same reason grok gets --always-approve).
  if (opts.skipPermissions !== false) args.push("--dangerously-skip-permissions");
  args.push("--disable-telemetry");
  if (opts.geminiDir) args.push("--gemini-dir", opts.geminiDir);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  return args;
}

/** agy's whole answer to a model call refused for an unverified account (see the AcpAgentKind note). */
export const AGY_AUTH_REQUIRED_RE = /^\s*\u26a0\s*Verification Required\s*$/;
/**
 * 0.2.3: a session/prompt JSON-RPC error that names quota exhaustion (Fondant, Fable-advised Neon meter design 2026-11-20).
 * Neon quota is not readable from any agy quota API (j:2682), so the first exhaustion is the only measurement we get.
 * Narrow on purpose: RESOURCE_EXHAUSTED, or a 429 / "quota" together with exceeded|exhausted wording. A bare rate-limit
 * 429 is NOT matched (it is not exhaustion). Never observed live yet: the raw error text rides on the line verbatim.
 */
export const AGY_QUOTA_RE = /RESOURCE_EXHAUSTED|\bquota\b[^"]{0,80}\b(exceeded|exhausted|reached)\b|\b(exceeded|exhausted|reached)\b[^"]{0,80}\bquota\b/i;
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
  /** 0.2.0: the ACP agent to drive (default "grok"). */
  agent?: AcpAgentKind;
  /** 0.2.0: ACP McpServer entries handed to session/new and session/load (agy spawns them). Default []. */
  mcpServers?: Json[];
  /** Model id (default grok-4.5). Passed to session/new when supported. */
  model?: string;
  /** Path to the grok binary (default: GROK_BIN env or "grok" on PATH). */
  grokBin?: string;
  onNotification?: (method: string, params: Json) => void;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Json) => void;
  /** Per-turn IDLE timeout (0.1.6, see turn-timeout.ts). Omitted or idleMs 0 = no timeout. */
  turnTimeout?: TurnTimeoutConfig;
  /** grok's stderr. Given: piped here (never the terminal directly, see log-sink.ts). Omitted: inherited, as before. */
  onStderr?: (chunk: Buffer) => void;
  /**
   * 0.1.13: asked when the IDLE timer fires, before any cancel. Returns the epoch ms of grok's newest
   * on-disk session write (any session under GROK_HOME, sub-agent sessions included), or null.
   * WHY (2026-11-10, eng-4118-5673-run2e turn 1): a sub-agent call ran 12:27:54Z-12:37:34Z with tool calls,
   * but grok sends a sub-session's updates to its own session file, not to our stdio stream. The bridge saw
   * 600 s of silence and cancelled a working turn. A write within idleMs re-arms the clock instead.
   */
  lastActivityMs?: () => number | null;
};

/** The one turn in flight (TurnGate serializes, so there is never more than one). */
type ActiveTurn = {
  turnId: string;
  reqId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the idle timer fired: whatever ends the turn now, it ends as "timeout". */
  timedOut: boolean;
  /** Any message from grok since the prompt (incl. _x.ai/*): ends the first-output phase. */
  heard: boolean;
  /** The limit the armed timer uses, and which phase it guards. */
  limitMs: number;
  phase: "first-output" | "idle";
  sessionId: string;
  /** The turn's agent_message_chunk text, capped: enough to recognise agy's auth-required answer. */
  text: string;
};

export class GrokAcpClient {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private opts: GrokAcpOptions;
  private turnCounter = 1;
  private loadSession = false;
  private turn: ActiveTurn | null = null;

  constructor(opts: GrokAcpOptions) {
    this.opts = opts;
  }

  private log(level: "info" | "warn" | "error", msg: string, fields?: Json) {
    this.opts.log?.(level, msg, fields);
  }

  private get agent(): AcpAgentKind {
    return this.opts.agent ?? "grok";
  }

  async start(): Promise<void> {
    if (this.agent === "antigravity") return this.startChild(
      this.opts.grokBin ?? process.env.AGY_BIN ?? "agy",
      buildAgyAcpArgs({
        geminiDir: process.env.AGY_GEMINI_DIR || undefined,
        addDirs: pluginDirsFromEnv(process.env.AGY_ADD_DIRS),
        skipPermissions: process.env.AGY_SKIP_PERMISSIONS !== "0",
      }),
    );
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
    return this.startChild(bin, args);
  }

  private async startChild(bin: string, args: string[]): Promise<void> {
    this.log("info", `spawning ${this.agent} ACP child`, { bin, args });
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", this.opts.onStderr ? "pipe" : "inherit"],
      cwd: this.opts.cwd,
      env: grokChildEnv(process.env),
    });
    this.child = child;
    // 0.2.1: the child dies with us. agy 1.5.13 does NOT exit on stdin EOF: a `screen -X quit` that ended the sidecar
    // left agy acp + its MCP servers (playwright, wallet...) running as orphans (neon-probe-1, 2026-11-20). An 'exit'
    // listener runs on every process.exit; it must be synchronous and must never throw (bun-1-4-exit-listener-throw).
    process.once("exit", () => {
      try {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
      } catch (e) {
        this.log("error", "could not SIGTERM the ACP child on exit", { pid: child.pid, err: String(e), stack: (e as Error)?.stack });
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    if (this.opts.onStderr && child.stderr) child.stderr.on("data", (chunk: Buffer) => this.opts.onStderr!(chunk));
    child.on("exit", (code: number | null) => {
      this.log("error", `${this.agent} ACP child exited`, { code });
      for (const [, p] of this.pending) p.reject(new Error(`grok agent exited (code ${code})`));
      this.pending.clear();
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const caps = (init.agentCapabilities ?? {}) as Json;
    this.loadSession = caps.loadSession === true;
    this.log("info", `${this.agent} ACP initialized`, { loadSession: this.loadSession, agentInfo: init.agentInfo ?? null });
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
    if (method != null) this.heardFromGrok();

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
      this.touchTurn();
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
      // _x.ai/* is NOT turn activity: only session/update proves the turn is producing output.
      if (method.startsWith("_x.ai/")) return;
      this.touchTurn();
      this.captureText(method, (msg.params ?? {}) as Json);
      this.opts.onNotification?.(method, (msg.params ?? {}) as Json);
    }
  }

  private captureText(method: string, params: Json): void {
    const turn = this.turn;
    if (!turn || method !== "session/update" || turn.text.length >= 2000) return;
    const update = (params.update ?? {}) as Json;
    if (update.sessionUpdate !== "agent_message_chunk") return;
    const t = (update.content as Json | undefined)?.text;
    if (typeof t === "string") turn.text = (turn.text + t).slice(0, 2000);
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
    return this.requestWithId(method, params).promise;
  }

  private requestWithId(method: string, params?: Json): { id: number; promise: Promise<Json> } {
    const id = this.nextId++;
    const promise = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, ...(params ? { params } : {}) });
    });
    return { id, promise };
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
          mcpServers: this.opts.mcpServers ?? [],
        });
        this.log("info", `${this.agent} session resumed`, { sessionId: persistedSessionId });
        await this.applyModel(persistedSessionId);
        return { threadId: persistedSessionId, resumed: true };
      } catch (e) {
        this.log("warn", "session/load failed — starting fresh", { err: String(e) });
      }
    }
    const r = await this.request("session/new", { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] });
    const sessionId = (r.sessionId ?? (r.session as Json | undefined)?.sessionId ?? r.id) as string | undefined;
    if (!sessionId) throw new Error(`session/new returned no sessionId: ${JSON.stringify(r)}`);
    const models = r.models as Json | undefined;
    const current = (models?.availableModels as Json[] | undefined)?.find((m) => m.modelId === models?.currentModelId);
    // reasoningEffort is what grok APPLIED: argv accepts any string, so the session answer is the proof (Brioche 651638).
    this.log("info", `${this.agent} session started`, { sessionId, model: models?.currentModelId, reasoningEffort: (current?._meta as Json | undefined)?.reasoningEffort ?? null,
      mcpServers: (this.opts.mcpServers ?? []).map((m) => m.name) });
    await this.applyModel(sessionId);
    return { threadId: sessionId, resumed: false };
  }

  /**
   * antigravity only: pin the model with session/set_model (agy acp has no --model). agy refuses an unknown id,
   * so a resolved call is the proof. A refusal is FATAL: a lane silently on the default model is the j:719 class.
   */
  private async applyModel(sessionId: string): Promise<void> {
    if (this.agent !== "antigravity" || !this.opts.model) return;
    try {
      await this.request("session/set_model", { sessionId, modelId: this.opts.model });
    } catch (e) {
      throw new Error(`session/set_model ${this.opts.model} refused: ${String(e)}`);
    }
    this.log("info", "model pinned (session/set_model accepted)", { sessionId, model: this.opts.model });
  }

  /**
   * Fire a prompt turn. Returns a synthetic turnId IMMEDIATELY (grok's
   * session/prompt resolves only at completion, so we can't block here). On
   * resolution we synthesize the `turn/completed` notification index.ts expects,
   * carrying grok's stopReason + token usage. With a turnTimeout, a turn that
   * produces nothing for idleMs is cancelled and completes as status "timeout"
   * (see turn-timeout.ts); `turn/completed` fires exactly once per turn either way.
   */
  startTurn(sessionId: string, text: string): Promise<string> {
    const turnId = String(this.turnCounter++);
    const { id: reqId, promise } = this.requestWithId("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    const turn: ActiveTurn = { turnId, reqId, idleTimer: null, graceTimer: null, timedOut: false, sessionId,
      heard: false, limitMs: 0, phase: "idle", text: "" };
    this.turn = turn;
    this.armIdle(turn);
    promise
      .then((r) => {
        const meta = (r._meta ?? {}) as Json;
        // grok reports usage at result._meta.usage; agy 1.5.13 at result.usage (probe 2026-11-20).
        const usage = meta.usage ?? r.usage ?? null;
        if (turn.timedOut) {
          this.finishTurn(turn, { status: "timeout", stopReason: r.stopReason ?? null, usage,
            timeout: { idleMs: turn.limitMs, cancelHonored: true, phase: turn.phase } });
        } else if (this.agent === "antigravity" && AGY_AUTH_REQUIRED_RE.test(turn.text)) {
          this.finishTurn(turn, { status: "auth_required", stopReason: r.stopReason ?? null, text: turn.text.trim() });
        } else {
          this.finishTurn(turn, { status: r.stopReason ?? "end_turn", usage });
        }
      })
      .catch((e) => {
        const err = String(e).slice(0, 4000);
        this.log("error", "session/prompt failed", { turnId, err });
        this.finishTurn(turn, turn.timedOut
          ? { status: "timeout", timeout: { idleMs: turn.limitMs, cancelHonored: false, phase: turn.phase } }
          : this.agent === "antigravity" && AGY_QUOTA_RE.test(err)
            ? { status: "quota_exhausted", err }
            : { status: "error", err });
      });
    // Resolve synchronously-ish so the gate marks the turn in-flight immediately.
    return Promise.resolve(turnId);
  }

  private armIdle(turn: ActiveTurn): void {
    const idleMs = this.opts.turnTimeout?.idleMs ?? 0;
    const firstMs = this.opts.turnTimeout?.firstOutputMs ?? 0;
    // Before grok has said anything, the shorter first-output limit guards the turn (it never LENGTHENS it).
    const first = !turn.heard && firstMs > 0 && (idleMs <= 0 || firstMs < idleMs);
    const ms = first ? firstMs : idleMs;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = null;
    if (ms <= 0) return;
    turn.limitMs = ms;
    turn.phase = first ? "first-output" : "idle";
    turn.idleTimer = setTimeout(() => this.onIdle(turn), ms);
  }

  /** ANY message from grok for the running turn ends its first-output phase; the idle rule takes over. */
  private heardFromGrok(): void {
    const turn = this.turn;
    if (!turn || turn.heard || turn.timedOut) return;
    turn.heard = true;
    if (turn.phase === "first-output") this.armIdle(turn);
  }

  /** Output from grok for the running turn: restart its idle clock (not once cancelling). */
  private touchTurn(): void {
    const turn = this.turn;
    if (turn && !turn.timedOut) this.armIdle(turn);
  }

  private onIdle(turn: ActiveTurn): void {
    if (this.turn !== turn) return;
    const { graceMs } = this.opts.turnTimeout!;
    const idleMs = turn.limitMs, phase = turn.phase;
    if (phase === "idle" && this.opts.lastActivityMs) {
      let last: number | null = null;
      try {
        last = this.opts.lastActivityMs();
      } catch (e) {
        this.log("error", "activity probe failed; idle timeout proceeds", { turnId: turn.turnId, err: String(e), stack: (e as Error)?.stack });
      }
      const quietMs = last == null ? null : Date.now() - last;
      if (quietMs != null && quietMs < idleMs) {
        this.log("info", "no stdio output, but a grok session file was written recently (sub-agent); idle clock re-armed",
          { turnId: turn.turnId, idleMs, quietMs });
        turn.idleTimer = null;
        turn.limitMs = idleMs;
        turn.idleTimer = setTimeout(() => this.onIdle(turn), Math.min(idleMs, Math.max(1000, idleMs - quietMs)));
        return;
      }
    }
    turn.timedOut = true;
    turn.idleTimer = null;
    this.log("error", phase === "first-output"
      ? "turn first-output timeout — NOTHING from grok since the prompt; sending session/cancel"
      : "turn idle timeout — no output from grok; sending session/cancel", { turnId: turn.turnId, idleMs, graceMs, phase });
    try {
      this.cancelTurn(turn.sessionId);
    } catch (e) {
      this.log("error", "session/cancel send failed on timeout", { turnId: turn.turnId, err: String(e) });
    }
    turn.graceTimer = setTimeout(() => {
      if (this.turn !== turn) return;
      // The prompt never resolved, even after cancel: abandon it. A late reply for reqId is dropped by dispatch.
      this.pending.delete(turn.reqId);
      this.log("error", "session/cancel not honoured within grace — abandoning the turn; grok child may be wedged", { turnId: turn.turnId, graceMs });
      this.finishTurn(turn, { status: "timeout", timeout: { idleMs, cancelHonored: false, phase } });
    }, graceMs);
  }

  private finishTurn(turn: ActiveTurn, fields: Json): void {
    if (this.turn !== turn) return; // already completed (timeout path won, or vice versa)
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    this.turn = null;
    this.opts.onNotification?.("turn/completed", { turn: { id: turn.turnId, ...fields } });
  }

  /**
   * Cancel the in-flight turn (ACP `session/cancel` is a NOTIFICATION). The pending session/prompt then
   * resolves with stopReason "cancelled", which startTurn turns into the usual `turn/completed`, so the
   * gate marks idle and pumps whatever was queued behind the cancelled turn.
   */
  cancelTurn(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
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
