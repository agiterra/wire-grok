/**
 * Kickoff idempotency for Grok lanes (2026-09-12, j:1507). Ported from codex-wire/src/kickoff-once.ts (AGI-81).
 *
 * bridge-tools spawn() delivers the task brief TWICE: as INITIAL_PROMPT at launch (crew agent_launch env) and,
 * minutes later, as a signed `bridge.kickoff` Wire message carrying the same `task` text. codex-wire drops the
 * second copy; wire-grok did not, so every Grok lane spawned on 2026-09-11 (ghari, poli, chiroti) received its
 * brief twice after finishing Turn 1. The brief's identity is the sha256 of its text; the first delivery is
 * recorded in <STATE_DIR>/<agentId>.kickoff.json and any later kickoff with the same id is suppressed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KickoffRecord = {
  kickoffId: string;
  agentId: string;
  deliveredAt: string;
  /** Set when a later bridge.kickoff with the same brief was suppressed — the durable proof the dedupe fired (0.1.3). */
  lastSuppressed?: { seq: number | undefined; at: string; count: number };
};

export function deriveKickoffId(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex").slice(0, 32);
}
export function kickoffPath(stateDir: string, agentId: string): string {
  return join(stateDir, `${agentId}.kickoff.json`);
}
export function readKickoff(stateDir: string, agentId: string): KickoffRecord | null {
  const p = kickoffPath(stateDir, agentId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as KickoffRecord; } catch { return null; }
}
export function recordKickoff(stateDir: string, agentId: string, kickoffId: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(kickoffPath(stateDir, agentId), JSON.stringify({ kickoffId, agentId, deliveredAt: new Date().toISOString() } satisfies KickoffRecord) + "\n");
}
/** The `task` text of a bridge.kickoff payload (object, or JSON string), or null when the shape is unknown. */
export function kickoffTaskText(payload: unknown): string | null {
  // bridge-tools POSTs the kickoff to the gateway's /webhooks/:dest/:topic, and the gateway delivers a webhook
  // ENVELOPE: { source, topic: "webhook.bridge.kickoff", dest, plugin, headers, payload: { task, roles, ... } }.
  // 0.1.1 read `.task` at the top level, found nothing, and silently skipped the dedupe (adhirasam 02:15Z, Brioche
  // 612482). Descend through nested `.payload` envelopes (bounded) until a string `task` appears.
  let p: unknown = payload;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
    if (!p || typeof p !== "object") return null;
    const o = p as { task?: unknown; payload?: unknown };
    if (typeof o.task === "string") return o.task;
    if (o.payload === undefined) return null;
    p = o.payload;
  }
  return null;
}
/** Record that a duplicate was suppressed: the sidecar's stderr lives only in the lane's screen, so the file is the evidence. */
export function markSuppressed(stateDir: string, agentId: string, seq: number | undefined): void {
  const rec = readKickoff(stateDir, agentId);
  if (!rec) return;
  rec.lastSuppressed = { seq, at: new Date().toISOString(), count: (rec.lastSuppressed?.count ?? 0) + 1 };
  writeFileSync(kickoffPath(stateDir, agentId), JSON.stringify(rec) + "\n");
}
/** True when this kickoff's brief was already delivered (same sha) — suppress it. */
export function isDuplicateKickoff(taskText: string, record: KickoffRecord | null): boolean {
  return !!record && record.kickoffId === deriveKickoffId(taskText);
}
