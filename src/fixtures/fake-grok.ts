#!/usr/bin/env bun
/**
 * Fake `grok agent stdio` for turn-timeout.test.ts. Behaviour is chosen by the prompt text:
 *   STALL         never answers session/prompt and ignores session/cancel (a wedged model call)
 *   STALL_CANCEL  never answers until session/cancel, then resolves stopReason "cancelled"
 *   ACTIVE:<n>    streams a session/update every 40 ms, n times, then resolves end_turn (long but live)
 *   XAI_ONLY:<n>  streams only _x.ai/* notifications (not turn output), n times, then never answers
 *   anything else resolves end_turn at once
 * Every line received is appended to FAKE_GROK_LOG so tests can assert what the client sent.
 */
import { appendFileSync } from "fs";
const logPath = process.env.FAKE_GROK_LOG;
const out = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let stalledCancelable: number | null = null;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    if (logPath) appendFileSync(logPath, line + "\n");
    const m = JSON.parse(line);
    if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
    else if (m.method === "session/new") out({ id: m.id, result: { sessionId: "s1" } });
    else if (m.method === "session/cancel") {
      if (stalledCancelable != null) { out({ id: stalledCancelable, result: { stopReason: "cancelled" } }); stalledCancelable = null; }
    } else if (m.method === "session/prompt") {
      const text: string = m.params.prompt[0].text;
      if (text === "STALL") { /* never answer */ }
      else if (text === "STALL_CANCEL") stalledCancelable = m.id;
      else if (text.startsWith("ACTIVE:") || text.startsWith("XAI_ONLY:")) {
        const xai = text.startsWith("XAI_ONLY:");
        let n = Number(text.split(":")[1]);
        const t = setInterval(() => {
          if (n-- > 0) {
            out(xai ? { method: "_x.ai/session_notification", params: { sessionId: "s1" } }
                    : { method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } } });
          } else {
            clearInterval(t);
            if (!xai) out({ id: m.id, result: { stopReason: "end_turn" } });
          }
        }, 40);
      } else out({ id: m.id, result: { stopReason: "end_turn", _meta: { usage: { totalTokens: 1 } } } });
    }
  }
});
