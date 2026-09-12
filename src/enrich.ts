/**
 * Prepend knowledge-plugin hook stdout onto an injected Wire prompt.
 *
 * Grok's UserPromptSubmit hook runs Claude-compatible hooks, but an allowing
 * hook's stdout / additionalContext is discarded (Grok user-guide 10-hooks.md).
 * The knowledge plugin's association + channel-enrichment hooks therefore
 * cannot inject via Grok's hook runner. This sidecar is the injection path,
 * so it runs the same hooks and prepends their stdout to session/prompt text.
 *
 * Opt-in remains KNOWLEDGE_ENRICH_RULES (same JSON the channel-enrichment
 * hook already parses). Unset → no-op, same as Claude.
 */
import { existsSync } from "fs";
import { join } from "path";

// association-hook on a full channel JSON is the github-webhook firehose
// (knowledge-claude-code v0.8.0 skipped it). Channel-enrichment searches
// payload.text only and is the Slack/IPC path Tim ordered on.
const HOOKS = ["channel-enrichment.ts"] as const;
const HOOK_TIMEOUT_MS = 8000;

export function findKnowledgePlugin(pluginDirs = process.env.GROK_PLUGIN_DIRS ?? ""): string | null {
  const explicit = process.env.KNOWLEDGE_PLUGIN_ROOT?.trim();
  if (explicit && existsSync(join(explicit, "hooks", "channel-enrichment.ts"))) return explicit;
  for (const d of pluginDirs.split(":")) {
    if (!d) continue;
    if (existsSync(join(d, "hooks", "channel-enrichment.ts"))) return d;
  }
  return null;
}

async function runHook(
  pluginRoot: string,
  hook: string,
  prompt: string,
  cwd: string,
  log: (level: string, msg: string, fields?: Record<string, unknown>) => void,
): Promise<string> {
  const script = join(pluginRoot, "hooks", hook);
  const proc = Bun.spawn(["bun", "run", script], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdin: new Blob([JSON.stringify({ prompt, cwd })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, HOOK_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (stderr.trim()) {
      log("warn", "enrich hook stderr", { hook, stderr: stderr.slice(0, 400) });
    }
    return stdout.trim();
  } finally {
    clearTimeout(killer);
  }
}

export async function enrichInjectedPrompt(
  text: string,
  opts: {
    cwd: string;
    log: (level: string, msg: string, fields?: Record<string, unknown>) => void;
  },
): Promise<string> {
  if (!process.env.KNOWLEDGE_ENRICH_RULES?.trim()) return text;
  const pluginRoot = findKnowledgePlugin();
  if (!pluginRoot) {
    opts.log("warn", "KNOWLEDGE_ENRICH_RULES set but knowledge plugin not found in GROK_PLUGIN_DIRS");
    return text;
  }
  const chunks = await Promise.all(
    HOOKS.map((h) =>
      runHook(pluginRoot, h, text, opts.cwd, opts.log).catch((e) => {
        opts.log("warn", "enrich hook failed", { hook: h, err: String(e) });
        return "";
      }),
    ),
  );
  const extra = chunks.filter(Boolean).join("\n");
  if (!extra) return text;
  opts.log("info", "prompt enriched", { bytes: extra.length });
  return extra + "\n\n" + text;
}
