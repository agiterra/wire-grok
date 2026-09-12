import { describe, expect, test } from "bun:test";
import { formatBatch, type QueuedEvent } from "./gate.ts";

const envelope = (seq: number, text: string): QueuedEvent => ({
  seq,
  source: "brioche",
  topic: "webhook.ipc",
  text: JSON.stringify({ source: "brioche", topic: "webhook.ipc", dest: "vacherin", plugin: "ipc", payload: { type: "gate_post_request", text } }),
});

describe("formatBatch operator tasking (0.1.4, j:1514)", () => {
  test("warden dest: header carries every wire seq, an injected-at time, and the compaction rule; each part is stamped", () => {
    const out = formatBatch([envelope(612744, "post api#1885"), envelope(612746, "merge api#1885")], { dest: "vacherin" });
    expect(out.startsWith("OPERATOR TASKING from brioche (signed dest=vacherin; wire seq 612744, 612746; injected 20")).toBe(true);
    expect(out).toContain("re-presented, not a resend");
    expect(out).toContain("[wire seq 612744 · injected 20");
    expect(out).toContain("[wire seq 612746 · injected 20");
    expect(out).toContain("post api#1885");
    expect(out).toContain("merge api#1885");
  });
  test("a missing seq renders as ? rather than being dropped", () => {
    const e = envelope(1, "x"); (e as { seq: number | undefined }).seq = undefined;
    expect(formatBatch([e], { dest: "vacherin" })).toContain("[wire seq ? · injected");
  });
  test("non-warden dest keeps the generic channel format (no operator header, no stamps)", () => {
    const out = formatBatch([envelope(612744, "post api#1885")], { dest: "kesari" });
    expect(out.startsWith("OPERATOR TASKING")).toBe(false);
    expect(out).not.toContain("[wire seq");
    expect(out).toContain("A Wire channel event arrived");
  });
});
