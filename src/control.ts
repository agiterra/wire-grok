/**
 * Operator control of a running Grok lane (0.1.5, Baguette 638792, 2026-09-28).
 *
 * A lane's screen runs this bridge, which never reads stdin: it talks ACP to `grok agent stdio` over a
 * pipe. So crew's agent_interrupt (keystrokes stuffed into the screen) cannot cancel a Grok turn, and
 * the only other lever, crew.agent_stop, is terminal. `bridge.cancel` is the sanctioned cancel: a
 * signed Wire message to the lane from an allowed sender -> ACP `session/cancel` on the active turn.
 * Queued events are NOT dropped: the turn ends "cancelled" and the next queued event (e.g. the hold
 * that prompted the cancel) runs as the next turn.
 */

/** Gateway-delivered topics arrive as `webhook.<topic>`; accept both spellings. */
export function isCancelTopic(topic: string): boolean {
  return topic === "bridge.cancel" || topic.endsWith(".bridge.cancel");
}

export const DEFAULT_CONTROL_ALLOW = "baguette,brioche,vacherin,fondant";

/** Wire `source` is the broker-verified sender id; compare exactly, never by prefix. */
export function cancelAllowed(source: string | undefined, allowCsv: string = DEFAULT_CONTROL_ALLOW): boolean {
  if (!source) return false;
  return allowCsv.split(",").map((s) => s.trim()).filter(Boolean).includes(source);
}

export type CancelResult =
  | { ok: false; reason: "sender not allowed"; sender: string | null }
  | { ok: true; cancelled: null; reason: "no turn in flight" }
  | { ok: true; cancelled: string; reason: "session/cancel sent" };

/** What a cancel request does, given who asked and what is running. Pure, so it is tested. */
export function decideCancel(source: string | undefined, activeTurnId: string, allowCsv?: string): CancelResult {
  if (!cancelAllowed(source, allowCsv)) return { ok: false, reason: "sender not allowed", sender: source ?? null };
  if (!activeTurnId) return { ok: true, cancelled: null, reason: "no turn in flight" };
  return { ok: true, cancelled: activeTurnId, reason: "session/cancel sent" };
}
