/**
 * LogSink — bridge log output that can never block the event loop (2026-10-10, Baguette 699219).
 *
 * WHY: the bridge logged with console.error straight to its screen's terminal. A TERMINAL write is synchronous in Bun
 * (console.error and process.stderr.write alike; measured under screen XOFF: a 200 ms timer stopped dead until XON).
 * A stalled terminal therefore stops every timer, the per-turn idle timeout included, and the bridge goes silent with
 * no evidence left: rv147-4443-pr2010-r1's timeout was due 22:49:29Z and no line ever appeared. (Pipes are not the
 * problem: Bun buffers pipe writes. It also reports NO backpressure on a child's stdin — no false from write(), no
 * 'drain', callbacks fire at once — so a relay we write into cannot be capped and would buffer without bound.)
 *
 * So the bridge only ever APPENDS TO A FILE (a regular file never waits on a reader). The screen shows that file
 * through a `tail -F` child whose stdout is the terminal: if the terminal stalls, tail blocks, the bridge does not,
 * and nothing is buffered in the bridge. The tail is killed when the bridge's pid goes away (macOS tail has no --pid),
 * so it cannot keep a dead lane's screen alive. grok's stderr is appended the same way.
 *
 * TERMINAL LOSS: `screen -X quit` delivers NO SIGHUP to a quiet process (measured: an idle bun survives it). The old
 * bridge died only because its next console.error hit EIO on the closed pty. With no terminal writes it would outlive
 * its screen forever. So the tail is the probe: its next copy hits the same EIO, it exits, the watcher exits with it,
 * and `onTerminalLost` fires (the bridge exits). Same latency as before: the next log line.
 * A sink failure never throws into the caller: an unwritable file falls back to the terminal, once announced.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type LogSinkOpts = { file: string; tty: boolean; watchPid?: number; onTerminalLost?: () => void };

export class LogSink {
  private relay: ChildProcess | null = null;
  private fileFailed = false;
  private stopping = false;

  constructor(private readonly opts: LogSinkOpts) {
    let size = 0;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, ""); // create it, so tail has something to follow
      size = statSync(opts.file).size;
    } catch (e) {
      this.fail(e);
    }
    if (opts.tty && !this.fileFailed) this.startRelay(size);
  }

  private startRelay(fromByte: number): void {
    const pid = this.opts.watchPid ?? process.pid;
    // $0 = file, $1 = start byte (1-based), $2 = owner pid. The loop ends when the owner is gone (then it kills tail)
    // or when tail is gone (terminal lost: then the owner hears about it through our exit).
    const script = 'tail -c +"$1" -F "$0" & t=$!; while kill -0 "$2" 2>/dev/null && kill -0 "$t" 2>/dev/null; do sleep 1; done; kill "$t" 2>/dev/null; wait "$t"';
    try {
      const r = spawn("/bin/sh", ["-c", script, this.opts.file, String(fromByte + 1), String(pid)],
        { stdio: ["ignore", "inherit", "inherit"], detached: false });
      r.on("exit", (code, sig) => {
        this.relay = null;
        this.toFile(`[log-sink] terminal tail exited (code ${code}, signal ${sig}); the log file is still written\n`);
        if (!this.stopping) this.opts.onTerminalLost?.();
      });
      r.unref();
      this.relay = r;
    } catch (e) {
      this.toFile(`[log-sink] terminal tail failed to start: ${String(e)}; file only\n`);
    }
  }

  private fail(e: unknown): void {
    if (this.fileFailed) return;
    this.fileFailed = true;
    // Last resort, and loud: without a file there is no non-blocking path, so we write the terminal directly.
    try { process.stderr.write(`[log-sink] log file ${this.opts.file} unwritable, writing the terminal directly: ${String(e)}\n`); } catch { /* nothing left */ }
  }

  private toFile(s: string): void {
    if (this.fileFailed) { try { process.stderr.write(s); } catch { /* nothing left */ } return; }
    try {
      appendFileSync(this.opts.file, s);
    } catch (e) {
      this.fail(e);
      try { process.stderr.write(s); } catch { /* nothing left */ }
    }
  }

  /** One complete line (a trailing newline is added if missing). */
  line(s: string): void {
    this.toFile(s.endsWith("\n") ? s : s + "\n");
  }

  /** A raw chunk from a child stream (grok stderr), as-is. */
  raw(chunk: string | Buffer): void {
    this.toFile(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  stop(): void {
    this.stopping = true;
    this.relay?.kill();
    this.relay = null;
  }

  stats(): { relay: boolean; fileFailed: boolean } {
    return { relay: this.relay !== null, fileFailed: this.fileFailed };
  }
}
