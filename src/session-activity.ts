import { readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Epoch ms of the newest grok session write under GROK_HOME, or null when there is none.
 *
 * grok writes every session's ACP updates to GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl,
 * sub-agent sessions included. A sub-agent's work never reaches the parent's stdio stream, so this is the only
 * place the bridge can see it (eng-4118-5673-run2e, 2026-11-10). One GROK_HOME belongs to one lane, so every
 * session here is this lane's grok.
 *
 * Only ENOENT is "no activity". Any other fs error throws: the caller logs it and lets the timeout proceed.
 */
export function newestSessionWriteMs(grokHome: string): number | null {
  const root = join(grokHome, "sessions");
  let newest: number | null = null;
  for (const cwdDir of list(root)) {
    for (const sessionDir of list(join(root, cwdDir))) {
      const file = join(root, cwdDir, sessionDir, "updates.jsonl");
      try {
        const m = statSync(file).mtimeMs;
        if (newest == null || m > newest) newest = m;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
      }
    }
  }
  return newest;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}
