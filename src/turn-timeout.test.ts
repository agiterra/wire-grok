import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GrokAcpClient } from "./grok-acp.js";
import { timeoutNotice, turnTimeoutFromEnv } from "./turn-timeout.js";

// Selftest for ASK-54: plant a stalled model call in a fake `grok agent stdio` and prove the turn
// ends as "timeout", exactly once, and the client takes the next turn (the queue drains).

const FAKE = join(import.meta.dir, "fixtures", "fake-grok.ts");
const IDLE = 150;
const GRACE = 100;

type Done = { id: string; status: string; timeout?: { idleMs: number; cancelHonored: boolean } };
let clients: GrokAcpClient[] = [];
afterEach(() => { for (const c of clients) c.stop(); clients = []; });

async function harness(idleMs = IDLE) {
  const logPath = join(mkdtempSync(join(tmpdir(), "fake-grok-")), "in.jsonl");
  process.env.FAKE_GROK_LOG = logPath;
  const done: Done[] = [];
  const c = new GrokAcpClient({
    cwd: tmpdir(), grokBin: FAKE, turnTimeout: { idleMs, graceMs: GRACE },
    onNotification: (m, p) => { if (m === "turn/completed") done.push((p as { turn: Done }).turn); },
  });
  clients.push(c);
  await c.start();
  const { threadId } = await c.ensureThread(null);
  const sent = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { c, threadId, done, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(10); }
}

describe("per-turn idle timeout (stalled model call)", () => {
  test("cancel ignored: turn ends timeout/cancelHonored=false after idle+grace, once; the next turn runs", async () => {
    const h = await harness();
    const t0 = Date.now();
    const id = await h.c.startTurn(h.threadId, "STALL");
    await until(() => h.done.length === 1);
    const took = Date.now() - t0;
    expect(h.done[0]).toMatchObject({ id, status: "timeout", timeout: { idleMs: IDLE, cancelHonored: false } });
    expect(took).toBeGreaterThanOrEqual(IDLE + GRACE - 10);
    expect(h.sent().some((m) => m.method === "session/cancel")).toBe(true);
    const id2 = await h.c.startTurn(h.threadId, "hello");
    await until(() => h.done.length === 2);
    expect(h.done[1]).toMatchObject({ id: id2, status: "end_turn" });
    await sleep(IDLE + GRACE + 50);
    expect(h.done.length).toBe(2); // no second completion for either turn
  });

  test("cancel honoured: turn ends timeout/cancelHonored=true before the grace runs out", async () => {
    const h = await harness();
    const t0 = Date.now();
    await h.c.startTurn(h.threadId, "STALL_CANCEL");
    await until(() => h.done.length === 1);
    expect(h.done[0]).toMatchObject({ status: "timeout", timeout: { idleMs: IDLE, cancelHonored: true } });
    expect(Date.now() - t0).toBeLessThan(IDLE + GRACE);
    await sleep(GRACE + 50);
    expect(h.done.length).toBe(1);
  });

  test("a long turn that keeps streaming session/update is NOT timed out", async () => {
    const h = await harness();
    await h.c.startTurn(h.threadId, "ACTIVE:12"); // ~480 ms total, far past IDLE, never idle for IDLE
    await until(() => h.done.length === 1);
    expect(h.done[0].status).toBe("end_turn");
    expect(h.sent().some((m) => m.method === "session/cancel")).toBe(false);
  });

  test("_x.ai/* bookkeeping does not count as turn output", async () => {
    const h = await harness();
    const t0 = Date.now();
    await h.c.startTurn(h.threadId, "XAI_ONLY:20"); // ~800 ms of _x.ai chatter
    await until(() => h.done.length === 1);
    expect(h.done[0]).toMatchObject({ status: "timeout", timeout: { cancelHonored: false } });
    expect(Date.now() - t0).toBeLessThan(IDLE + GRACE + 200); // timed out DURING the chatter, not after it
  });

  test("idleMs 0 disables the timeout", async () => {
    const h = await harness(0);
    await h.c.startTurn(h.threadId, "STALL");
    await sleep(IDLE + GRACE + 100);
    expect(h.done.length).toBe(0);
    expect(h.sent().some((m) => m.method === "session/cancel")).toBe(false);
  });

  test("a normal turn completes with its stopReason and no cancel", async () => {
    const h = await harness();
    await h.c.startTurn(h.threadId, "hi");
    await until(() => h.done.length === 1);
    expect(h.done[0].status).toBe("end_turn");
    await sleep(IDLE + 50);
    expect(h.sent().some((m) => m.method === "session/cancel")).toBe(false);
    expect(h.done.length).toBe(1);
  });
});

describe("turnTimeoutFromEnv", () => {
  test("defaults: 600 s idle, 30 s grace", () => {
    expect(turnTimeoutFromEnv({}, () => {})).toEqual({ idleMs: 600_000, graceMs: 30_000 });
  });
  test("per-agent knob and 0 = disabled", () => {
    expect(turnTimeoutFromEnv({ GROK_TURN_TIMEOUT_SECS: "1200", GROK_TURN_CANCEL_GRACE_SECS: "5" }, () => {}))
      .toEqual({ idleMs: 1_200_000, graceMs: 5_000 });
    expect(turnTimeoutFromEnv({ GROK_TURN_TIMEOUT_SECS: "0" }, () => {}).idleMs).toBe(0);
  });
  test("garbage falls back to the default AND is reported", () => {
    const warns: string[] = [];
    expect(turnTimeoutFromEnv({ GROK_TURN_TIMEOUT_SECS: "10m" }, (w) => warns.push(w)).idleMs).toBe(600_000);
    expect(turnTimeoutFromEnv({ GROK_TURN_TIMEOUT_SECS: "-5" }, (w) => warns.push(w)).idleMs).toBe(600_000);
    expect(warns.length).toBe(2);
  });
});

describe("timeoutNotice", () => {
  const batch = [
    { text: "x", topic: "ipc", source: "baguette", seq: 7 },
    { text: "y", topic: "slack", source: "mivid-studios", seq: 8 },
    { text: "z", topic: "ipc", source: "baguette", seq: 9 },
  ];
  test("notifies the configured list plus operator senders, once each, never webhooks or self", () => {
    const n = timeoutNotice({ lane: "vacherin", turnId: "4", info: { idleMs: 600_000, cancelHonored: false }, batch,
      notifyCsv: "brioche,vacherin", operatorCsv: "baguette,brioche,vacherin,fondant" });
    expect(n.dests.sort()).toEqual(["baguette", "brioche"]);
    expect(n.payload).toMatchObject({ lane: "vacherin", turn_id: "4", idle_secs: 600, cancel_honored: false });
    expect(n.payload.events).toEqual([
      { source: "baguette", topic: "ipc", seq: 7 }, { source: "mivid-studios", topic: "slack", seq: 8 }, { source: "baguette", topic: "ipc", seq: 9 },
    ]);
    expect(String(n.payload.text)).toContain("TIMED OUT after 10 min");
    expect(String(n.payload.text)).toContain("may be wedged");
  });
  test("cancel honoured reads differently", () => {
    const n = timeoutNotice({ lane: "herald", turnId: "1", info: { idleMs: 90_000, cancelHonored: true }, batch: [],
      notifyCsv: "brioche", operatorCsv: "" });
    expect(n.dests).toEqual(["brioche"]);
    expect(String(n.payload.text)).toContain("1.5 min");
    expect(String(n.payload.text)).toContain("was honoured");
  });
});
