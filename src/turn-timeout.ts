/**
 * Per-turn timeout (0.1.6, ASK-54: Tim YES 2026-10-02, relayed Brioche 651540).
 *
 * A Grok turn whose model call stalls never resolves its session/prompt, so the TurnGate stays busy
 * forever and every later Wire event queues behind it, unseen. The timeout is IDLE time, not wall
 * time: it fires when the grok child has sent nothing for this turn (no session/update, no
 * permission request) for GROK_TURN_TIMEOUT_SECS. A stalled model call streams nothing; a long but
 * live turn (a 15-minute test run between tool updates is the edge) keeps resetting it. Wall-clock
 * would kill legitimate long lane turns, because Grok lanes run this same sidecar.
 *
 * On expiry: ACP session/cancel, then GROK_TURN_CANCEL_GRACE_SECS for the prompt to resolve. If it
 * does not, the bridge abandons the request and completes the turn itself. Either way the turn ends
 * with status "timeout", the queue drains, and a `bridge.turn.timeout` notice goes onto the Wire.
 */

import type { QueuedEvent } from "./gate.js";

export const DEFAULT_TURN_TIMEOUT_SECS = 600;
/**
 * FIRST-OUTPUT limit (0.1.10, Brioche 722285): a turn that has heard NOTHING from grok — not even _x.ai/*
 * bookkeeping — for this long is wedged. rv843-3923-pr1606 (2026-10-15 20:21Z): grok 1.0.13 logged "prompt
 * received" and then nothing for 600 s, and ignored session/cancel. In 24 healthy grok lanes the first message
 * after the prompt came within 2.2 s. ANY message ends this phase (a turn may open with a 130 s auto-compaction
 * that grok announces only as _x.ai/session/update auto_compact_started); after it the 600 s IDLE rule applies
 * unchanged, still counting only session/update and permission requests.
 */
export const DEFAULT_FIRST_OUTPUT_SECS = 120;
export const DEFAULT_CANCEL_GRACE_SECS = 30;
export const DEFAULT_TIMEOUT_NOTIFY = "brioche";

export type TurnTimeoutConfig = { idleMs: number; graceMs: number; /** 0 or omitted = off */ firstOutputMs?: number };

/** Parse one seconds knob. Unset -> default; 0 -> 0 (disabled); anything unparseable -> default, reported. */
function secs(raw: string | undefined, dflt: number, name: string, warn: (msg: string) => void): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warn(`${name}=${JSON.stringify(raw)} is not a non-negative number of seconds; using ${dflt}`);
    return dflt;
  }
  return n;
}

/** GROK_TURN_TIMEOUT_SECS (default 600; 0 disables), GROK_TURN_CANCEL_GRACE_SECS (default 30), and
 *  GROK_TURN_FIRST_OUTPUT_SECS (default 120; 0 disables). */
export function turnTimeoutFromEnv(env: Record<string, string | undefined>, warn: (msg: string) => void): TurnTimeoutConfig {
  return {
    idleMs: secs(env.GROK_TURN_TIMEOUT_SECS, DEFAULT_TURN_TIMEOUT_SECS, "GROK_TURN_TIMEOUT_SECS", warn) * 1000,
    graceMs: secs(env.GROK_TURN_CANCEL_GRACE_SECS, DEFAULT_CANCEL_GRACE_SECS, "GROK_TURN_CANCEL_GRACE_SECS", warn) * 1000,
    firstOutputMs: secs(env.GROK_TURN_FIRST_OUTPUT_SECS, DEFAULT_FIRST_OUTPUT_SECS, "GROK_TURN_FIRST_OUTPUT_SECS", warn) * 1000,
  };
}

/** idleMs = the limit that FIRED; phase "first-output" = grok sent nothing at all since the prompt. */
export type TimeoutInfo = { idleMs: number; cancelHonored: boolean; phase?: "first-output" | "idle" };

function csv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Who hears about a timed-out turn, and what they read. Recipients: GROK_TURN_TIMEOUT_NOTIFY
 * (default brioche) plus every batch sender who is an allowed operator (the agent who tasked the
 * turn wants to know it died). Webhook sources (slack orgs, github) are not agents and are skipped.
 */
export function timeoutNotice(opts: {
  lane: string;
  turnId: string;
  info: TimeoutInfo;
  batch: QueuedEvent[];
  notifyCsv: string;
  operatorCsv: string;
}): { dests: string[]; payload: Record<string, unknown> } {
  const operators = new Set(csv(opts.operatorCsv));
  const dests = new Set(csv(opts.notifyCsv));
  for (const e of opts.batch) if (operators.has(e.source)) dests.add(e.source);
  dests.delete(opts.lane);
  const mins = Math.round(opts.info.idleMs / 6000) / 10;
  const outcome = opts.info.cancelHonored
    ? "session/cancel was honoured"
    : "session/cancel was NOT honoured within the grace period, so the grok child may be wedged and the lane may need a restart";
  const events = opts.batch.map((e) => ({ source: e.source, topic: e.topic, seq: e.seq ?? null }));
  return {
    dests: [...dests],
    payload: {
      lane: opts.lane,
      turn_id: opts.turnId,
      idle_secs: opts.info.idleMs / 1000,
      phase: opts.info.phase ?? "idle",
      cancel_honored: opts.info.cancelHonored,
      events,
      text:
        `${opts.lane}: turn ${opts.turnId} TIMED OUT after ${mins} min with ` +
        `${opts.info.phase === "first-output" ? "NOTHING at all from grok since the prompt (wedged before its first output)" : "no output from grok"}; ${outcome}. ` +
        `Its ${events.length} event(s) (${events.map((e) => `${e.source}${e.seq != null ? ` seq ${e.seq}` : ""}`).join(", ")}) ` +
        `got no answer. Queued events continue.`,
    },
  };
}
