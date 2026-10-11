import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { LogSink } from "./log-sink.ts";

const BUN = process.execPath;
const SINK = join(import.meta.dir, "log-sink.ts");

/** A STALLED TERMINAL: python opens a pty, runs the child with the pty as stdout+stderr, and never reads the master.
 *  The child ticks a 50 ms timer 20 times while logging 4 KB lines, then writes "done". Returns whether it finished. */
function runOnStalledTty(body: string, ms = 5000): { done: boolean; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "log-sink-"));
  const script = join(dir, "child.ts");
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
import { LogSink } from ${JSON.stringify(SINK)};
const dir = ${JSON.stringify(dir)};
let n = 0;
const big = "x".repeat(4096);
${body}
const t = setInterval(() => {
  n++;
  for (let i = 0; i < 8; i++) emit(JSON.stringify({ n, i, big }));
  if (n >= 20) { clearInterval(t); writeFileSync(dir + "/done", String(n)); process.exit(0); }
}, 50);
`);
  const py = `
import os, pty, subprocess, sys, time
m, s = pty.openpty()
p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=subprocess.DEVNULL, stdout=s, stderr=s, start_new_session=True)
os.close(s)
deadline = time.time() + float(sys.argv[3])
while p.poll() is None and time.time() < deadline: time.sleep(0.05)
if p.poll() is None:
    os.killpg(p.pid, 9)
`;
  spawnSync("python3", ["-c", py, BUN, script, String(ms / 1000)], { stdio: "ignore" });
  let done = false;
  try { done = readFileSync(join(dir, "done"), "utf8") === "20"; } catch { /* not done */ }
  return { done, dir };
}

describe("LogSink", () => {
  test("control: console.error to a stalled terminal stops the event loop (the rv147 failure shape)", () => {
    expect(runOnStalledTty(`const emit = (s: string) => console.error(s);`, 3000).done).toBe(false);
  }, 10000);

  test("timers keep running on a stalled terminal; the file has every line", () => {
    const r = runOnStalledTty(`const sink = new LogSink({ file: dir + "/bridge.log", tty: true });
const emit = (s: string) => sink.line(s);`);
    expect(r.done).toBe(true);
    const lines = readFileSync(join(r.dir, "bridge.log"), "utf8").split("\n").filter((l) => l.startsWith("{"));
    expect(lines.length).toBe(160);
  }, 10000);

  test("the terminal shows the file: tail copies new lines to stdout, from the start byte, not old content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "log-sink-"));
    const file = join(dir, "b.log");
    writeFileSync(file, "old line from a previous run\n");
    const script = join(dir, "c.ts");
    writeFileSync(script, `import { LogSink } from ${JSON.stringify(SINK)};
const s = new LogSink({ file: ${JSON.stringify(file)}, tty: true });
s.line("fresh one"); s.raw(Buffer.from("grok stderr chunk\\n"));
setTimeout(() => process.exit(0), 1500);`);
    const out = spawnSync(BUN, [script], { encoding: "utf8", timeout: 8000 }).stdout;
    expect(out).toContain("fresh one");
    expect(out).toContain("grok stderr chunk");
    expect(out).not.toContain("old line");
  }, 10000);

  test("the tail dies with its owner pid, so it cannot hold a dead lane's screen open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "log-sink-"));
    const owner = spawn("/bin/sleep", ["1"]);
    const sink = new LogSink({ file: join(dir, "b.log"), tty: true, watchPid: owner.pid });
    expect(sink.stats().relay).toBe(true);
    await new Promise((r) => setTimeout(r, 4500));
    expect(sink.stats().relay).toBe(false);
    expect(readFileSync(join(dir, "b.log"), "utf8")).toContain("terminal tail exited");
  }, 10000);

  test("an unwritable file falls back to the terminal, loudly, and never throws", () => {
    const sink = new LogSink({ file: "/nonexistent-root-dir/x/b.log", tty: false });
    expect(sink.stats().fileFailed).toBe(true);
    expect(() => sink.line("still logs")).not.toThrow();
    expect(existsSync("/nonexistent-root-dir")).toBe(false);
  });
  test("terminal loss: when the screen closes, the owner is told and exits (the old EIO death, kept)", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-sink-"));
    const script = join(dir, "c.ts");
    writeFileSync(script, `import { writeFileSync } from "node:fs";
import { LogSink } from ${JSON.stringify(SINK)};
const s = new LogSink({ file: ${JSON.stringify(join(dir, "b.log"))}, tty: true,
  onTerminalLost: () => { writeFileSync(${JSON.stringify(join(dir, "lost"))}, "1"); process.exit(129); } });
setInterval(() => s.line("tick " + Date.now()), 100);`);
    const py = `
import os, pty, subprocess, sys, time
m, s = pty.openpty()
p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=s, stdout=s, stderr=s, start_new_session=True)
os.close(s)
end = time.time() + 1.5
while time.time() < end:
    try: os.read(m, 65536)
    except OSError: break
os.close(m)
deadline = time.time() + 8
while p.poll() is None and time.time() < deadline: time.sleep(0.1)
alive = p.poll() is None
if alive: os.killpg(p.pid, 9)
print("ALIVE" if alive else "EXITED", p.returncode)
`;
    const out = spawnSync("python3", ["-c", py, BUN, script], { encoding: "utf8", timeout: 15000 }).stdout;
    expect(out).toContain("EXITED");
    expect(existsSync(join(dir, "lost"))).toBe(true);
  }, 20000);
});
