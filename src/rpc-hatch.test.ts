import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createConnection } from "net";
import { startRpcHatch } from "./rpc-hatch";

// The hatch signs with sendSignedMessage; a fetch stub counts sends without a broker.
test("half-closed client (nc style) gets nothing sent; an open client still is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-rpc-"));
  const sock = join(dir, "rpc.sock");
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  let sends = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { sends++; return new Response("{}", { status: 200 }); }) as any;
  const hatch = startRpcHatch({ sockPath: sock, url: "http://127.0.0.1:1", agentId: "t", signingKey: key.privateKey, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const line = JSON.stringify({ dest: "crew-svc@x", method: "crew.ping", timeoutMs: 200 }) + "\n";
    await new Promise<void>((res) => { const c = createConnection(sock); c.on("connect", () => c.end(line)); c.on("close", () => res()); c.on("error", () => res()); });
    const nc = Bun.spawn(["nc", "-U", sock], { stdin: new TextEncoder().encode(line), stdout: "pipe" });
    expect(await new Response(nc.stdout).text()).toBe("");
    await new Promise((r) => setTimeout(r, 300));
    expect(sends).toBe(0);
    const out = await new Promise<string>((res) => { const c = createConnection(sock); let b = ""; c.on("data", (d) => { b += d; if (b.includes("\n")) { c.end(); res(b); } }); c.on("connect", () => c.write(line)); });
    expect(sends).toBe(1);
    expect(JSON.parse(out).error).toContain("timed out");
  } finally {
    globalThis.fetch = realFetch; hatch.close(); rmSync(dir, { recursive: true, force: true });
  }
});
