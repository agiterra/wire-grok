#!/usr/bin/env bun
/**
 * grok-wire-bridge — Wire sidecar for a single Grok agent.
 *
 * The grok analog of codex-wire-bridge: closes Grok's channel-injection gap.
 * CC agents get Wire events pushed into their conversation by the wire plugin;
 * Grok (phase-1 runtime) was OUTBOUND-only via its wire-ipc MCP. This bridge
 * holds the agent's Wire SSE connection (wire-tools WireConnection — heartbeats,
 * reconnect, frozen-worker watchdog) and a `grok agent stdio` ACP session;
 * channel events become session/prompt turns, queued while a turn is in flight
 * and flushed as one batched turn on completion.
 *
 * Env (identity flows exactly like a crew spawn):
 *   AGENT_ID            required — Wire agent id (and session owner)
 *   AGENT_PRIVATE_KEY   required — base64 PKCS8 Ed25519 (register_agent fresh-mode output)
 *   WIRE_URL            required — gateway base URL
 *   PROJECT_DIR         required — cwd for the grok ACP session
 *   AGENT_NAME          optional — display name (defaults to AGENT_ID)
 *   INITIAL_PROMPT      optional — first turn (role/task brief), sent through the gate
 *   GROK_MODEL          optional — model id (default grok-4.5)
 *   GROK_BIN            optional — grok binary path (default: "grok" on PATH)
 *   STATE_DIR           optional — sessionId persistence (default ~/.wire/grok-bridge)
 *
 * Outbound is NOT this bridge's job: grok agents send via their wire-ipc MCP
 * entry in ~/.grok/config.toml, unchanged.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { WireConnection } from "@agiterra/wire-tools/connection";
import { importKeyPair } from "@agiterra/wire-tools/crypto";
import { GrokAcpClient } from "./grok-acp.js";
import { TurnGate, formatBatch, shouldSteerInFlight, type QueuedEvent } from "./gate.js";
import { enrichInjectedPrompt } from "./enrich.js";
import { startRpcHatch } from "./rpc-hatch.js";
import { isCancelTopic, decideCancel, DEFAULT_CONTROL_ALLOW } from "./control.js";
import { sendSignedMessage } from "@agiterra/wire-tools/http";
import { deriveKickoffId, isDuplicateKickoff, kickoffTaskText, markSuppressed, readKickoff, recordKickoff } from "./kickoff-once.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[grok-wire-bridge] fatal: ${name} env var required`);
    process.exit(1);
  }
  return v;
}

const agentId = requireEnv("AGENT_ID");
const agentName = process.env.AGENT_NAME ?? agentId;
const wireUrl = requireEnv("WIRE_URL");
const projectDir = requireEnv("PROJECT_DIR");
const model = process.env.GROK_MODEL ?? "grok-4.5";
const stateDir = process.env.STATE_DIR ?? join(process.env.HOME ?? "/tmp", ".wire", "grok-bridge");
const statePath = join(stateDir, `${agentId}.json`);

function log(level: string, msg: string, fields?: Record<string, unknown>) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level, name: "grok-wire-bridge", agent: agentId, msg, ...fields }));
}

function readState(): { threadId: string } | null {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(threadId: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ threadId, agentId, projectDir, updatedAt: new Date().toISOString() }) + "\n");
}

const gate = new TurnGate();
let threadId = "";
let activeTurnId = "";

// System topics that must never become model turns — a model invocation per
// keepalive is pure token burn carrying zero information.
const SKIP_TOPICS = new Set([
  "wire.keepalive",
  "wire.connection_state",
  // RPC request/reply must not become model turns. Replies belong to an
  // RpcClient on THIS connection, not a second SSE.
  "rpc.request",
  "rpc.reply",
  "webhook.rpc.request",
  "webhook.rpc.reply",
]);

const grok = new GrokAcpClient({
  cwd: projectDir,
  model,
  log: (level, msg, fields) => log(level, msg, fields),
  onNotification: (method, params) => {
    if (method === "turn/completed") {
      const turn = (params as { turn?: { status?: string; usage?: unknown } }).turn;
      log("info", "turn completed", { status: turn?.status, usage: turn?.usage });
      activeTurnId = "";
      if (gate.complete()) void pump();
    }
  },
});

async function pump(): Promise<void> {
  const batch = gate.take();
  if (!batch) return;
  const text = await enrichInjectedPrompt(formatBatch(batch, { dest: agentId }), { cwd: projectDir, log });
  log("info", "injecting turn", { events: batch.length, pending: gate.pending });
  try {
    activeTurnId = await grok.startTurn(threadId, text);
  } catch (e) {
    // prompt refused (e.g. a race with an active turn): re-mark idle so the
    // next completion or event retries; never drop the batch silently.
    log("error", "session/prompt failed — requeueing batch", { err: String(e) });
    gate.complete();
    for (const ev of batch) gate.push(ev);
  }
}

async function main(): Promise<void> {
  const keyPair = await importKeyPair(requireEnv("AGENT_PRIVATE_KEY"));
  const rpcSock = process.env.GROK_RPC_SOCK ?? join(stateDir, `${agentId}.rpc.sock`);
  process.env.GROK_RPC_SOCK = rpcSock;
  const hatch = startRpcHatch({
    sockPath: rpcSock,
    url: wireUrl,
    agentId,
    signingKey: keyPair.privateKey,
    log,
  });

  await grok.start();
  const prior = readState();
  const t = await grok.ensureThread(prior?.threadId ?? null);
  threadId = t.threadId;
  writeState(threadId);

  const conn = new WireConnection({
    url: wireUrl,
    agentId,
    agentName,
    keyPair,
    deliver: async ({ raw, channel }) => {
      if (hatch.handleEvent(raw)) return;
      if (SKIP_TOPICS.has(raw.topic)) return;
      // Operator cancel (0.1.5): never a model turn. Reply to the sender with what happened.
      if (isCancelTopic(raw.topic)) {
        const result = decideCancel(raw.source, activeTurnId, process.env.BRIDGE_CONTROL_ALLOW ?? DEFAULT_CONTROL_ALLOW);
        if (result.ok && result.cancelled) grok.cancelTurn(threadId);
        log(result.ok ? "info" : "warn", "bridge.cancel", { from: raw.source, seq: raw.seq, ...result });
        if (raw.source) {
          await sendSignedMessage(wireUrl, agentId, keyPair.privateKey, "bridge.cancel.result",
            { lane: agentId, request_seq: raw.seq ?? null, ...result }, raw.source)
            .catch((e: unknown) => log("error", "bridge.cancel.result send failed", { to: raw.source, err: String(e) }));
        }
        return;
      }
      // Kickoff idempotency (j:1507): the bridge sends the brief as INITIAL_PROMPT AND as bridge.kickoff.
      if (raw.topic === "bridge.kickoff" || raw.topic.endsWith(".bridge.kickoff")) {
        const task = kickoffTaskText(raw.payload);
        if (task === null) {
          // Stated silence: a kickoff we cannot read is delivered as a normal turn AND logged, never skipped quietly.
          log("warn", "bridge.kickoff payload shape unknown — no `task` string found, NOT deduped", { seq: raw.seq, payloadKeys: raw.payload && typeof raw.payload === "object" ? Object.keys(raw.payload as object) : typeof raw.payload });
        } else {
          const rec = readKickoff(stateDir, agentId);
          if (isDuplicateKickoff(task, rec)) { markSuppressed(stateDir, agentId, raw.seq); log("info", "duplicate kickoff suppressed — same brief already delivered", { seq: raw.seq, kickoffId: rec?.kickoffId, deliveredAt: rec?.deliveredAt }); return; }
          log("info", "bridge.kickoff carries a different brief — delivering", { seq: raw.seq, incoming: deriveKickoffId(task), recorded: rec?.kickoffId ?? null, taskLen: task.length });
          recordKickoff(stateDir, agentId, deriveKickoffId(task));
        }
      }
      const ev: QueuedEvent = {
        text: channel.text,
        topic: raw.topic,
        source: raw.source,
        seq: raw.seq,
      };
      if (gate.busy && activeTurnId && shouldSteerInFlight(ev.topic)) {
        try {
          await grok.steerTurn(threadId, activeTurnId, await enrichInjectedPrompt(formatBatch([ev], { dest: agentId }), { cwd: projectDir, log }));
          log("info", "steered deadline event into active turn", { topic: ev.topic, seq: ev.seq, turnId: activeTurnId });
          return;
        } catch (e) {
          // grok has no mid-turn steer (v0) — queue it; grok's prompt queue
          // runs it as the next turn, same net effect.
          log("info", "steer unsupported — queueing deadline event", { topic: ev.topic, seq: ev.seq, err: String(e) });
          if (gate.push(ev)) void pump();
          return;
        }
      }
      if (gate.push(ev)) void pump();
      else log("info", "event queued (turn in flight)", { pending: gate.pending, topic: ev.topic });
    },
    onConnect: (sessionId) => log("info", "wire connected", { sessionId }),
    onDisconnect: () => log("warn", "wire disconnected — reconnecting"),
    onError: (e) => log("error", "wire error", { err: String(e) }),
  });
  // wire-tools retries startup failures internally and forever. Race the connect
  // against a loud periodic warning so a stuck startup (e.g. a 409 registration
  // loop) is visible HERE, never silent.
  const started = conn.start();
  let connected = false;
  void started.then(() => { connected = true; });
  const warn = setInterval(() => {
    if (!connected) {
      log("error", "wire connection NOT ESTABLISHED — wire-tools is retrying internally; check ~/.wire/wire-connection.jsonl (common cause: registration 409 pubkey/encoding mismatch — register the RAW 44-char pubkey)", { waitedMs: 60_000 });
    }
  }, 60_000);
  await started;
  clearInterval(warn);

  const initialPrompt = process.env.INITIAL_PROMPT;
  if (initialPrompt && !t.resumed) {
    recordKickoff(stateDir, agentId, deriveKickoffId(initialPrompt)); // the brief is now delivered once; a later bridge.kickoff with the same text is a duplicate (j:1507)
    if (gate.push({ text: initialPrompt, topic: "bridge.boot", source: "grok-wire-bridge", seq: undefined })) void pump();
  }

  log("info", "bridge up", { threadId, resumed: t.resumed, projectDir, wireUrl, model });
}

main().catch((e) => {
  log("error", "fatal", { err: String(e?.stack ?? e) });
  process.exit(1);
});
