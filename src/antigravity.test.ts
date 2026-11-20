import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GrokAcpClient, acpAgentFromEnv, buildAgyAcpArgs, AGY_AUTH_REQUIRED_RE } from "./grok-acp.js";
import { newestFileWriteMs } from "./session-activity.ts";

// 0.2.0: ACP_AGENT=antigravity (Google agy acp). Shapes from the 2026-11-20 agy 1.5.13 probes.
const FAKE = join(import.meta.dir, "fixtures", "fake-grok.ts");
type Done = { id: string; status: string; usage?: unknown; text?: string };
let clients: GrokAcpClient[] = [];
afterEach(() => { for (const c of clients) c.stop(); clients = []; delete process.env.AGY_GEMINI_DIR; });

async function agy(model = "gemini-4-neon-low", mcpServers: Record<string, unknown>[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "fake-agy-"));
  process.env.FAKE_GROK_LOG = join(dir, "in.jsonl");
  process.env.FAKE_GROK_ARGV = join(dir, "argv.json");
  process.env.AGY_GEMINI_DIR = join(dir, "gemini");
  const done: Done[] = [];
  const c = new GrokAcpClient({ cwd: tmpdir(), grokBin: FAKE, agent: "antigravity", model, mcpServers,
    onNotification: (m, p) => { if (m === "turn/completed") done.push((p as { turn: Done }).turn); } });
  clients.push(c);
  const sent = () => existsSync(process.env.FAKE_GROK_LOG!) ? readFileSync(process.env.FAKE_GROK_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { c, dir, done, sent };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(10); }
}

describe("acpAgentFromEnv", () => {
  test("default grok; antigravity and its alias agy; anything else throws", () => {
    expect(acpAgentFromEnv({})).toBe("grok");
    expect(acpAgentFromEnv({ ACP_AGENT: "antigravity" })).toBe("antigravity");
    expect(acpAgentFromEnv({ ACP_AGENT: " AGY " })).toBe("antigravity");
    expect(() => acpAgentFromEnv({ ACP_AGENT: "gemini" })).toThrow(/not a known ACP agent/);
  });
});

describe("buildAgyAcpArgs", () => {
  test("acp + skip-permissions + no telemetry + per-lane gemini dir + add-dirs", () => {
    expect(buildAgyAcpArgs({ geminiDir: "/l/g", addDirs: ["/a", "/b"] })).toEqual(
      ["acp", "--dangerously-skip-permissions", "--disable-telemetry", "--gemini-dir", "/l/g", "--add-dir", "/a", "--add-dir", "/b"]);
  });
  test("skipPermissions false drops only that flag; no --model ever (agy acp has none)", () => {
    const a = buildAgyAcpArgs({ skipPermissions: false });
    expect(a).toEqual(["acp", "--disable-telemetry"]);
  });
});

test("AGY_AUTH_REQUIRED_RE matches agy's whole answer, not a mention of it", () => {
  expect(AGY_AUTH_REQUIRED_RE.test("\n⚠ Verification Required\n")).toBe(true);
  expect(AGY_AUTH_REQUIRED_RE.test("I saw '⚠ Verification Required' in the log")).toBe(false);
});

describe("antigravity client against the fake", () => {
  test("spawns agy acp argv, hands mcpServers to session/new, pins the model with session/set_model", async () => {
    const mcp = [{ name: "wire-ipc", command: "/bin/true", args: [], env: [{ name: "AGENT_ID", value: "lane" }] }];
    const h = await agy("gemini-4-neon-low", mcp);
    await h.c.start();
    await h.c.ensureThread(null);
    expect(JSON.parse(readFileSync(process.env.FAKE_GROK_ARGV!, "utf8"))).toEqual(
      ["acp", "--dangerously-skip-permissions", "--disable-telemetry", "--gemini-dir", join(h.dir, "gemini")]);
    const sent = h.sent();
    expect(sent.find((m) => m.method === "session/new").params.mcpServers).toEqual(mcp);
    expect(sent.find((m) => m.method === "session/set_model").params).toEqual({ sessionId: "s1", modelId: "gemini-4-neon-low" });
  });

  test("a refused model pin is fatal, never a silent default", async () => {
    const h = await agy("no-such-model");
    await h.c.start();
    await expect(h.c.ensureThread(null)).rejects.toThrow(/set_model no-such-model refused/);
  });

  test("'Verification Required' end_turn completes as auth_required; the next turn still runs", async () => {
    const h = await agy();
    await h.c.start();
    const { threadId } = await h.c.ensureThread(null);
    await h.c.startTurn(threadId, "AUTHREQ");
    await until(() => h.done.length === 1);
    expect(h.done[0]).toMatchObject({ status: "auth_required", text: "⚠ Verification Required" });
    await h.c.startTurn(threadId, "USAGE_TOP");
    await until(() => h.done.length === 2);
    expect(h.done[1]).toMatchObject({ status: "end_turn", usage: { totalTokens: 7 } });
  });

  test("grok client sends no set_model (its model is argv)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-grok-"));
    process.env.FAKE_GROK_LOG = join(dir, "in.jsonl");
    const c = new GrokAcpClient({ cwd: tmpdir(), grokBin: FAKE, model: "grok-4.7" });
    clients.push(c);
    await c.start();
    await c.ensureThread(null);
    const sent = readFileSync(process.env.FAKE_GROK_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(sent.some((m) => m.method === "session/set_model")).toBe(false);
    expect(sent.find((m) => m.method === "session/new").params.mcpServers).toEqual([]);
  });
});

test("newestFileWriteMs: newest mtime in the dir, null when the dir is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
  expect(newestFileWriteMs(join(dir, "nope"))).toBeNull();
  mkdirSync(join(dir, "c"));
  writeFileSync(join(dir, "c", "a.db"), "x");
  writeFileSync(join(dir, "c", "a.db-wal"), "x");
  utimesSync(join(dir, "c", "a.db"), 1000, 1000);
  utimesSync(join(dir, "c", "a.db-wal"), 2000, 2000);
  expect(newestFileWriteMs(join(dir, "c"))).toBe(2_000_000);
});
