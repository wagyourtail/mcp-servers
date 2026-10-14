// Task registry for the task_runner server: detached long-running subprocesses
// with per-task log files and pid persistence so a server restart can reattach.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type TaskStatus = "running" | "exited" | "killed" | "lost";

export interface TaskMeta {
  id: string;
  name?: string;
  argv: string[];
  cwd: string;
  pid: number;
  logPath: string;
  startedAt: string;
  status: TaskStatus;
  exitCode?: number | null;
  exitSignal?: string | null;
  finishedAt?: string;
}

interface LiveTask {
  meta: TaskMeta;
  proc?: ChildProcess; // absent after server restart — we can still kill(-pid) and read logs
}

export interface TaskStartOptions {
  argv: string[];
  cwd?: string;
  name?: string;
  env?: Record<string, string>;
  /** Pipe stdin (only usable while this server process stays alive). */
  stdin?: boolean;
}

export interface TaskLogResult {
  path: string;
  bytes: number;
  truncated: boolean;
  /** last `lines` lines (or fewer), without trailing newline */
  tail: string;
}

const DEFAULT_TAIL = 200;

export class TaskRegistry {
  private tasks = new Map<string, LiveTask>();
  private stateDir: string;
  private registryPath: string;

  get stateDirPath(): string {
    return this.stateDir;
  }

  constructor(stateDir?: string) {
    this.stateDir =
      stateDir ??
      process.env.TASKD_STATE_DIR ??
      join(homedir(), ".local", "state", "taskd");
    mkdirSync(this.stateDir, { recursive: true });
    this.registryPath = join(this.stateDir, "tasks.json");
    this.load();
  }

  /** Reattach to survivors, mark the rest lost. */
  private load(): void {
    if (!existsSync(this.registryPath)) return;
    let metas: TaskMeta[];
    try {
      metas = JSON.parse(readFileSync(this.registryPath, "utf-8"));
    } catch {
      return;
    }
    for (const meta of metas) {
      if (meta.status !== "running") {
        this.tasks.set(meta.id, { meta });
        continue;
      }
      try {
        process.kill(meta.pid, 0); // existence check
        this.tasks.set(meta.id, { meta });
      } catch {
        meta.status = "lost";
        meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
        this.tasks.set(meta.id, { meta });
      }
    }
    this.persist();
  }

  private persist(): void {
    writeFileSync(
      this.registryPath,
      JSON.stringify([...this.tasks.values()].map((t) => t.meta), null, 2),
    );
  }

  private update(meta: TaskMeta, patch: Partial<TaskMeta>): void {
    Object.assign(meta, patch);
    this.persist();
  }

  start(opts: TaskStartOptions): TaskMeta {
    if (!opts.argv.length || !opts.argv[0]) throw new Error("argv must be a non-empty array");
    const id = randomBytes(6).toString("hex");
    const logPath = join(this.stateDir, `${id}.log`);
    const fd = openSync(logPath, "a");
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    // detached: child is a process-group leader, survives server restart, and
    // kill(-pid) reaps the whole group (children of the task included).
    const proc = spawn(opts.argv[0], opts.argv.slice(1), {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      detached: true,
      stdio: [opts.stdin ? "pipe" : "ignore", fd, fd],
    });
    const meta: TaskMeta = {
      id,
      name: opts.name,
      argv: opts.argv,
      cwd,
      pid: proc.pid!,
      logPath,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    const task: LiveTask = { meta, proc };
    this.tasks.set(id, task);
    proc.on("exit", (code, signal) => {
      this.update(meta, {
        status: signal ? "killed" : "exited",
        exitCode: code,
        exitSignal: signal,
        finishedAt: new Date().toISOString(),
      });
    });
    proc.on("error", (e) => {
      this.update(meta, {
        status: "exited",
        finishedAt: new Date().toISOString(),
      });
      appendLog(logPath, `[taskd spawn error: ${e.message}]\n`);
    });
    proc.unref();
    this.persist();
    return meta;
  }

  get(id: string): TaskMeta | undefined {
    return this.tasks.get(id)?.meta;
  }

  list(): TaskMeta[] {
    return [...this.tasks.values()]
      .map((t) => t.meta)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Read the task log tail. */
  log(id: string, lines = DEFAULT_TAIL, maxBytes = 256 * 1024): TaskLogResult {
    const meta = this.get(id);
    if (!meta) throw new Error(`no task ${id}`);
    if (!existsSync(meta.logPath)) return { path: meta.logPath, bytes: 0, truncated: false, tail: "" };
    const size = statSync(meta.logPath).size;
    const fd = openSync(meta.logPath, "r");
    try {
      const readBytes = Math.min(size, maxBytes);
      const buf = Buffer.alloc(readBytes);
      readAt(fd, buf, size - readBytes);
      const text = buf.toString("utf-8");
      const kept = text.split("\n").slice(-lines).join("\n").replace(/\n$/, "");
      return { path: meta.logPath, bytes: size, truncated: size > readBytes, tail: kept };
    } finally {
      closeFd(fd);
    }
  }

  /** SIGTERM (or given signal) the process group; SIGKILL after graceMs if still alive. */
  async kill(id: string, signal: NodeJS.Signals = "SIGTERM", graceMs = 3000): Promise<TaskMeta> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    const { meta } = task;
    if (meta.status !== "running") return meta;
    signalGroup(meta.pid, signal);
    if (graceMs > 0) {
      const gone = await waitFor(() => meta.status !== "running", graceMs);
      if (!gone) signalGroup(meta.pid, "SIGKILL");
    }
    // Always settle the exit bookkeeping before returning — with a live proc
    // handle the exit event updates meta; reattached tasks are reconciled via
    // pid liveness.
    await waitFor(() => meta.status !== "running" || !pidAlive(meta.pid), 3000);
    if (!pidAlive(meta.pid) && meta.status === "running") {
      this.update(meta, { status: "exited", finishedAt: new Date().toISOString() });
    }
    return meta;
  }

  /** Resolve when the task leaves `running` or `seconds` elapse. */
  async wait(id: string, seconds: number): Promise<TaskMeta> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    const { meta } = task;
    if (meta.status === "running") {
      await waitFor(() => meta.status !== "running" || !pidAlive(meta.pid), seconds * 1000);
      // Reattached tasks have no exit event — reconcile from pid liveness.
      if (meta.status === "running" && !pidAlive(meta.pid)) {
        this.update(meta, { status: "exited", finishedAt: new Date().toISOString() });
      }
    }
    return meta;
  }

  /** Write to a task's stdin. Only works while this server process spawned it. */
  stdin(id: string, text: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    if (task.meta.status !== "running") throw new Error(`task ${id} is not running`);
    if (!task.proc?.stdin?.writable) {
      throw new Error(
        task.proc
          ? `task ${id} was not started with stdin enabled`
          : `task ${id} was reattached after a restart — stdin unavailable`,
      );
    }
    task.proc.stdin.write(text);
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

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // detached => pid is a group leader
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function readAt(fd: number, buf: Buffer, position: number): void {
  readSync(fd, buf, 0, buf.length, position);
}

function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

function appendLog(path: string, text: string): void {
  try {
    appendFileSync(path, text);
  } catch {
    /* best effort */
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}
