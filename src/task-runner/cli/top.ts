// top — `top`-style TUI for task_runner tasks.
// Pure builtins: reads tasks.json + /proc directly, so it works whether or not
// the server is up. Entry: `node src/cli.ts task_runner_top`
// (or `npm run task_runner_top`).
import { emitKeypressEvents } from "node:readline";
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Meta {
  id: string;
  name?: string;
  argv: string[];
  pid: number;
  logPath: string;
  startedAt: string;
  status: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  finishedAt?: string;
}

const STATE_DIR = process.env.TASKD_STATE_DIR ?? join(homedir(), ".local", "state", "taskd");
const TICK_MS = 1000;
const CLK_TCK = 100; // USER_HZ on Linux

function metas(): Meta[] {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, "tasks.json"), "utf-8")) as Meta[];
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** utime+stime jiffies from /proc/<pid>/stat (after the comm field's last ')'). */
function procJiffies(pid: number): number | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch {
    return undefined;
  }
}

function procRssKb(pid: number): number | undefined {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf-8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Warn on PID reuse: live cmdline should contain argv[0]'s basename. */
function pidMatchesArgv(meta: Meta): boolean {
  try {
    const cmd = readFileSync(`/proc/${meta.pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
    const want = meta.argv[0].split("/").pop()!;
    return cmd.some((c) => c.includes(want));
  } catch {
    return true; // can't read — don't warn
  }
}

function lastLogLine(path: string): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    closeSync(fd);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
    return (lines.at(-1) ?? "").slice(0, 60);
  } catch {
    return "";
  }
}

function fmtAge(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m${(s % 60) | 0}s`;
  return `${(s / 3600) | 0}h${((s % 3600) / 60) | 0}m`;
}

function fmtMem(kb?: number): string {
  if (kb === undefined) return "-";
  return kb < 1024 * 10 ? `${kb}K` : `${(kb / 1024).toFixed(0)}M`;
}

const prevCpu = new Map<number, { j: number; t: number }>();
let sel = 0;

function render(): void {
  const rows = metas();
  if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
  const now = Date.now();
  const W = process.stdout.columns || 120;
  const lines = [
    ` tasktop — ${STATE_DIR}/tasks.json — ${rows.length} task(s)  (↑↓ select · x SIGTERM · X SIGKILL · l log tail · q quit)`,
    "",
    ` ${"ID".padEnd(14)}${"NAME".padEnd(22)}${"PID".padEnd(8)}${"STATUS".padEnd(20)}${"CPU%".padEnd(7)}${"RSS".padEnd(7)}${"AGE".padEnd(8)}COMMAND`,
  ];
  rows.forEach((m, i) => {
    const alive = pidAlive(m.pid);
    const st = m.status === "running" ? (alive ? "running" : "gone!") : m.status;
    let cpu = "-";
    if (alive) {
      const j = procJiffies(m.pid);
      const prev = prevCpu.get(m.pid);
      if (j !== undefined && prev) cpu = (((j - prev.j) / ((now - prev.t) / 1000)) / CLK_TCK * 100).toFixed(1);
      if (j !== undefined) prevCpu.set(m.pid, { j, t: now });
    }
    const reused = alive && !pidMatchesArgv(m) ? " !pid-reused" : "";
    const cmd = m.argv.join(" ").slice(0, Math.max(20, W - 72));
    const mark = i === sel ? ">" : " ";
    lines.push(`${mark} ${m.id.padEnd(14)}${(m.name ?? "").slice(0, 21).padEnd(22)}${String(m.pid).padEnd(8)}${(st + reused).padEnd(20)}${cpu.padEnd(7)}${fmtMem(procRssKb(m.pid)).padEnd(7)}${fmtAge(m.startedAt).padEnd(8)}${cmd}`);
  });
  const selMeta = rows[sel];
  lines.push("");
  if (selMeta) {
    lines.push(` log: ${selMeta.logPath}`);
    lines.push(` tail: ${lastLogLine(selMeta.logPath)}`);
    if (selMeta.finishedAt) lines.push(` exit: code=${selMeta.exitCode} signal=${selMeta.exitSignal} at ${selMeta.finishedAt}`);
  }
  // redraw in place
  process.stdout.write(`\x1b[H\x1b[2J${lines.map((l) => l.slice(0, W)).join("\n")}\n`);
}

let inPager = false;

async function tailLog(path: string): Promise<void> {
  // simple pager: last 40 lines, any key returns
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(Math.min(size, 256 * 1024));
  readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
  closeSync(fd);
  const lines = buf.toString("utf-8").split("\n").slice(-40);
  process.stdout.write(`\x1b[H\x1b[2J${path}\n\n${lines.join("\n")}\n\n[any key to return]\n`);
  inPager = true;
  await new Promise((r) => process.stdin.once("keypress", r));
  inPager = false;
}

if (!existsSync(join(STATE_DIR, "tasks.json"))) {
  console.error(`no task registry at ${STATE_DIR}/tasks.json`);
  process.exit(1);
}
emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
let paused = false;
process.stdin.on("keypress", async (_s, k) => {
  if (!k || inPager) return;
  const rows = metas();
  if (k.name === "q" || k.name === "escape" || (k.ctrl && k.name === "c")) {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.exit(0);
  }
  if (k.name === "down" || k.name === "j") sel = Math.min(rows.length - 1, sel + 1);
  if (k.name === "up" || k.name === "k") sel = Math.max(0, sel - 1);
  if (k.name === "space") paused = !paused;
  if ((k.sequence === "x" || k.sequence === "X") && rows[sel] && pidAlive(rows[sel].pid)) {
    const sig = k.sequence === "X" ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-rows[sel].pid, sig); // process group, like task_kill
    } catch {
      try {
        process.kill(rows[sel].pid, sig);
      } catch { /* dead already */ }
    }
  }
  if (k.name === "l" && rows[sel] && existsSync(rows[sel].logPath)) await tailLog(rows[sel].logPath);
  render();
});
const timer = setInterval(() => {
  if (!paused) render();
}, TICK_MS);
timer.unref();
render();
