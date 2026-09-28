import { describe, expect, test } from "bun:test";
import { cancelAllowed, decideCancel, isCancelTopic } from "./control.ts";
import { GrokAcpClient } from "./grok-acp.js";

describe("bridge.cancel (0.1.5, Baguette 638792)", () => {
  test("topic: bare and gateway-wrapped spellings, nothing looser", () => {
    expect(isCancelTopic("bridge.cancel")).toBe(true);
    expect(isCancelTopic("webhook.bridge.cancel")).toBe(true);
    expect(isCancelTopic("bridge.cancel.result")).toBe(false);
    expect(isCancelTopic("ipc")).toBe(false);
  });
  test("sender allowlist is exact, never a prefix", () => {
    expect(cancelAllowed("baguette")).toBe(true);
    expect(cancelAllowed("baguette-evil")).toBe(false);
    expect(cancelAllowed("eng-4478")).toBe(false);
    expect(cancelAllowed(undefined)).toBe(false);
    expect(cancelAllowed("herald", "herald, brioche")).toBe(true);
  });
  test("decide: refused / idle / cancels the active turn", () => {
    expect(decideCancel("eng-1", "3")).toEqual({ ok: false, reason: "sender not allowed", sender: "eng-1" });
    expect(decideCancel("brioche", "")).toEqual({ ok: true, cancelled: null, reason: "no turn in flight" });
    expect(decideCancel("brioche", "7")).toEqual({ ok: true, cancelled: "7", reason: "session/cancel sent" });
  });
  test("cancelTurn writes an ACP session/cancel NOTIFICATION (no id) for the session", () => {
    const writes: string[] = [];
    const c = new GrokAcpClient({ cwd: "/tmp", log: () => {} } as never);
    (c as unknown as { child: unknown }).child = { stdin: { write: (s: string) => { writes.push(s); return true; } } };
    c.cancelTurn("sess-1");
    expect(writes.length).toBe(1);
    const m = JSON.parse(writes[0]);
    expect(m).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess-1" } });
  });
});
