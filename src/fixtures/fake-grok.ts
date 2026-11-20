#!/usr/bin/env bun
/**
 * Fake `grok agent stdio` for turn-timeout.test.ts. Behaviour is chosen by the prompt text:
 *   STALL         never answers session/prompt and ignores session/cancel (a wedged model call)
 *   STALL_CANCEL  never answers until session/cancel, then resolves stopReason "cancelled"
 *   ACTIVE:<n>    streams a session/update every 40 ms, n times, then resolves end_turn (long but live)
 *   XAI_ONLY:<n>  streams only _x.ai/* notifications (not turn output), n times, then never answers
 *   SUBAGENT:<n>  sends NOTHING on stdio; appends to $FAKE_GROK_HOME/sessions/c/sub/updates.jsonl every 40 ms,
 *                 n times, then resolves end_turn (a sub-agent working in its own session, 0.1.13)
 *   SUBAGENT_STALL:<n>  the same n writes, then never answers (a sub-agent that went quiet)
 *   AUTHREQ       (agy, 0.2.0) one agent_message_chunk "\n\u26a0 Verification Required\n", then end_turn
 *   USAGE_TOP     (agy, 0.2.0) end_turn with usage at result.usage (agy's shape), not result._meta.usage
 *   anything else resolves end_turn at once
 * session/set_model (agy, 0.2.0): modelId "no-such-model" -> error -32602, anything else -> {}.
 * FAKE_GROK_ARGV, when set, receives this process's argv (JSON) at startup.
 * Every line received is appended to FAKE_GROK_LOG so tests can assert what the client sent.
 */
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { writeFileSync } from "fs";
const logPath = process.env.FAKE_GROK_LOG;
if (process.env.FAKE_GROK_ARGV) writeFileSync(process.env.FAKE_GROK_ARGV, JSON.stringify(process.argv.slice(2)));
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
    else if (m.method === "session/set_model") {
      if (m.params.modelId === "no-such-model") out({ id: m.id, error: { code: -32602, message: "Unknown model ID: no-such-model" } });
      else out({ id: m.id, result: {} });
    }
    else if (m.method === "session/cancel") {
      if (stalledCancelable != null) { out({ id: stalledCancelable, result: { stopReason: "cancelled" } }); stalledCancelable = null; }
    } else if (m.method === "session/prompt") {
      const text: string = m.params.prompt[0].text;
      if (text === "STALL") { /* never answer */ }
      else if (text === "AUTHREQ") {
        out({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\u26a0 Verification Required\n" } } } });
        out({ id: m.id, result: { stopReason: "end_turn" } });
      }
      else if (text === "USAGE_TOP") out({ id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } });
      else if (text === "STALL_CANCEL") stalledCancelable = m.id;
      else if (text.startsWith("SUBAGENT:") || text.startsWith("SUBAGENT_STALL:")) {
        const stall = text.startsWith("SUBAGENT_STALL:");
        const dir = join(process.env.FAKE_GROK_HOME!, "sessions", "c", "sub");
        mkdirSync(dir, { recursive: true });
        let n = Number(text.split(":")[1]);
        const t = setInterval(() => {
          if (n-- > 0) appendFileSync(join(dir, "updates.jsonl"), "{}\n");
          else { clearInterval(t); if (!stall) out({ id: m.id, result: { stopReason: "end_turn" } }); }
        }, 40);
      }
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
