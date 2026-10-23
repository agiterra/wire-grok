/**
 * Ride grok-wire's existing AGENT_ID SSE for crew RPC.
 * MCP children speak JSON-lines on a unix socket; this process signs
 * rpc.request over HTTP and correlates rpc.reply frames from the SSE.
 * No second Wire SSE.
 */
import { existsSync, unlinkSync } from "fs";
import { createServer, type Server } from "net";
import { sendSignedMessage, type WireEvent } from "@agiterra/wire-tools/http";

const RPC_REQUEST_TOPIC = "rpc.request";
const RPC_REPLY_TOPIC = "rpc.reply";

function normalizeTopic(topic: string): string {
  return topic.startsWith("webhook.") ? topic.slice("webhook.".length) : topic;
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function framePayload(event: WireEvent): unknown {
  let p = parsePayload(event.payload);
  if (
    p !== null &&
    typeof p === "object" &&
    "payload" in (p as Record<string, unknown>) &&
    "headers" in (p as Record<string, unknown>)
  ) {
    p = parsePayload((p as Record<string, unknown>).payload);
  }
  return p;
}

/** How long a request waits for a half-close before it is sent. nc's EOF follows its line within milliseconds. */
export const DISPATCH_DELAY_MS = 100;

/**
 * What a lane may reach through this hatch. Same rules as the Codex hatch (codex-wire src/crew-rpc-hatch.ts,
 * RPC_TARGETS); Brioche GO 2026-10-23 after the nc incident showed this hatch forwarded any dest and method.
 * This list is transport, not authority: crew-svc and the review broker still check the caller.
 */
const RPC_TARGETS: ReadonlyArray<{ label: string; dest: RegExp; method: RegExp }> = [
  { label: "crew-svc", dest: /^crew-svc@[a-zA-Z0-9._-]+$/, method: /^crew\.[a-z_]+$/ },
  { label: "review broker", dest: /^github-review-broker@[a-zA-Z0-9._-]+$/, method: /^github\.(coderabbit_full_review|review_thread_reply)$/ },
];

/** null when (dest, method) is allowed, else the refusal reason. */
export function rpcTargetRefusal(dest: unknown, method: unknown): string | null {
  if (typeof dest !== "string" || typeof method !== "string") return "RPC requires a string dest and method";
  const rule = RPC_TARGETS.find((r) => r.dest.test(dest));
  if (!rule) return `RPC destination not allowed: ${RPC_TARGETS.map((r) => r.label).join(" or ")} only`;
  if (!rule.method.test(method)) return `RPC method ${method} not allowed for the ${rule.label} destination`;
  return null;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RpcHatch = {
  sockPath: string;
  handleEvent: (raw: WireEvent) => boolean;
  close: () => void;
};

export function startRpcHatch(opts: {
  sockPath: string;
  url: string;
  agentId: string;
  signingKey: CryptoKey;
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
}): RpcHatch {
  const pending = new Map<string, Pending>();

  function handleEvent(raw: WireEvent): boolean {
    if (normalizeTopic(raw.topic) !== RPC_REPLY_TOPIC) return false;
    const payload = framePayload(raw) as { rpc?: { id?: string }; ok?: boolean; result?: unknown; error?: string } | undefined;
    const id = payload?.rpc?.id;
    if (!id) return false;
    const p = pending.get(id);
    if (!p) return true; // consumed as RPC, late reply
    clearTimeout(p.timer);
    pending.delete(id);
    if (payload?.ok) p.resolve(payload.result);
    else p.reject(new Error(payload?.error ?? "unknown remote error"));
    return true;
  }

  async function request(dest: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = crypto.randomUUID();
    const payload = {
      rpc: { id, reply_to: opts.agentId, reply_topic: RPC_REPLY_TOPIC },
      method,
      params,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${method} to ${dest} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    await sendSignedMessage(opts.url, opts.agentId, opts.signingKey, RPC_REQUEST_TOPIC, payload, dest);
    return result;
  }

  try { if (existsSync(opts.sockPath)) unlinkSync(opts.sockPath); } catch { /* stale */ }

  const server: Server = createServer((sock) => {
    let buf = "";
    let ended = false;
    sock.setEncoding("utf8");
    sock.on("end", () => { ended = true; });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      void (async () => {
        try {
          const msg = JSON.parse(line) as { dest?: string; method?: string; params?: unknown; timeoutMs?: number };
          if (!msg.dest || !msg.method) throw new Error("rpc-hatch: dest and method required");
          const refusal = rpcTargetRefusal(msg.dest, msg.method);
          if (refusal) throw new Error(refusal);
          // A half-closed client (`printf … | nc -U`) can never read the reply; sending would act unseen
          // (codex hatch incident 2026-10-23 07:57Z, double CodeRabbit post risk). Wait for its EOF; send nothing.
          await new Promise((r) => setTimeout(r, DISPATCH_DELAY_MS));
          if (ended || sock.destroyed) {
            opts.log("warn", "rpc hatch client closed before dispatch; nothing sent", { method: msg.method, dest: msg.dest });
            return;
          }
          const result = await request(msg.dest, msg.method, msg.params, msg.timeoutMs ?? 120_000);
          sock.end(JSON.stringify({ ok: true, result }) + "\n");
        } catch (e) {
          sock.end(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }) + "\n");
        }
      })();
    });
  });
  server.listen(opts.sockPath);
  opts.log("info", "rpc hatch listening", { sock: opts.sockPath });

  return {
    sockPath: opts.sockPath,
    handleEvent,
    close: () => {
      server.close();
      try { unlinkSync(opts.sockPath); } catch { /* gone */ }
    },
  };
}
