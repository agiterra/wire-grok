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

export type KickoffRecord = { kickoffId: string; agentId: string; deliveredAt: string };

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
  let p: unknown = payload;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
  if (p && typeof p === "object" && typeof (p as { task?: unknown }).task === "string") return (p as { task: string }).task;
  return null;
}
/** True when this kickoff's brief was already delivered (same sha) — suppress it. */
export function isDuplicateKickoff(taskText: string, record: KickoffRecord | null): boolean {
  return !!record && record.kickoffId === deriveKickoffId(taskText);
}
