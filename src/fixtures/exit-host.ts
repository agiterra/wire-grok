#!/usr/bin/env bun
// exit-host: starts a GrokAcpClient on the fake agent, prints READY, then exits on a signal the way index.ts does.
import { join } from "path";
import { GrokAcpClient } from "../grok-acp.js";
for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) process.on(sig, () => process.exit(code));
const c = new GrokAcpClient({ cwd: process.cwd(), grokBin: join(import.meta.dir, "fake-grok.ts"), agent: "antigravity" });
await c.start();
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
