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
  /** Extra env vars recorded so task_restart can replay the spec. */
  env?: Record<string, string>;
  /** Whether the task was started with a stdin pipe (restart replays it). */
  stdin?: boolean;
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

export interface TaskWaitResult {
  task: TaskMeta;
  /** Present when `match` was given: whether the regex ever appeared. */
  matched?: boolean;
  matchedLine?: string;
}

const DEFAULT_TAIL = 200;
/** Logs are append-only and unbounded — prune to the tail past this size. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const KEEP_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Truncate a log to its last KEEP_LOG_BYTES once it passes MAX_LOG_BYTES.
 * Safe against concurrent writers: children hold the fd O_APPEND, so each of
 * their writes re-seeks to the (new) EOF — no holes.
 */
function pruneLog(path: string): void {
  try {
    const size = statSync(path).size;
    if (size <= MAX_LOG_BYTES) return;
    const fd = openSync(path, "r");
    let tail: Buffer;
    try {
      tail = Buffer.alloc(KEEP_LOG_BYTES);
      readAt(fd, tail, size - KEEP_LOG_BYTES);
    } finally {
      closeFd(fd);
    }
    writeFileSync(
      path,
      `[taskd: pruned ${size - KEEP_LOG_BYTES} bytes of old log]\n` + tail.toString("utf-8"),
    );
  } catch {
    /* best effort */
  }
}

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

  /** Spawn the child for task.meta and wire exit bookkeeping. */
  private spawnFor(task: LiveTask): void {
    const { meta } = task;
    const fd = openSync(meta.logPath, "a");
    // detached: child is a process-group leader, survives server restart, and
    // kill(-pid) reaps the whole group (children of the task included).
    const proc = spawn(meta.argv[0], meta.argv.slice(1), {
      cwd: meta.cwd,
      env: { ...process.env, ...(meta.env ?? {}) },
      detached: true,
      stdio: [meta.stdin ? "pipe" : "ignore", fd, fd],
    });
    meta.pid = proc.pid!;
    task.proc = proc;
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
      appendLog(meta.logPath, `[taskd spawn error: ${e.message}]\n`);
    });
    proc.unref();
  }

  start(opts: TaskStartOptions): TaskMeta {
    if (!opts.argv.length || !opts.argv[0]) throw new Error("argv must be a non-empty array");
    const id = randomBytes(6).toString("hex");
    const meta: TaskMeta = {
      id,
      name: opts.name,
      argv: opts.argv,
      cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
      env: opts.env,
      stdin: opts.stdin,
      pid: 0,
      logPath: join(this.stateDir, `${id}.log`),
      startedAt: new Date().toISOString(),
      status: "running",
    };
    const task: LiveTask = { meta };
    this.tasks.set(id, task);
    this.spawnFor(task);
    this.persist();
    return meta;
  }

  /**
   * Kill (if running) and respawn with the recorded argv/cwd/env/stdin — same
   * task id and log file (a restart marker is appended to the log).
   */
  async restart(id: string, graceMs = 3000): Promise<TaskMeta> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    await this.kill(id, "SIGTERM", graceMs);
    const { meta } = task;
    appendLog(meta.logPath, `\n[taskd restart ${new Date().toISOString()}]\n`);
    this.update(meta, {
      status: "running",
      exitCode: undefined,
      exitSignal: undefined,
      finishedAt: undefined,
      startedAt: new Date().toISOString(),
    });
    this.spawnFor(task);
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
    pruneLog(meta.logPath);
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

  /**
   * Resolve when the task leaves `running`, `seconds` elapse, or (with `match`)
   * a line matching the regex appears in the log — whichever first. A final
   * scan runs after exit so output flushed just before death still matches.
   */
  async wait(id: string, seconds: number, match?: string): Promise<TaskWaitResult> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`no task ${id}`);
    const { meta } = task;
    const re = match !== undefined ? new RegExp(match) : undefined;
    let hit: string | undefined;
    const scan = (): boolean => {
      if (!re) return false;
      try {
        const { tail } = this.log(id, 2000, 512 * 1024);
        const line = tail.split("\n").find((l) => re.test(l));
        if (line !== undefined) {
          hit = line;
          return true;
        }
      } catch {
        /* log may not exist yet */
      }
      return false;
    };
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (scan()) break;
      pruneLog(meta.logPath);
      if (meta.status !== "running" || !pidAlive(meta.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (hit === undefined && re) scan(); // final scan post-exit/timeout
    // Reattached tasks have no exit event — reconcile from pid liveness.
    if (meta.status === "running" && !pidAlive(meta.pid)) {
      this.update(meta, { status: "exited", finishedAt: new Date().toISOString() });
    }
    return { task: meta, ...(re ? { matched: hit !== undefined, matchedLine: hit } : {}) };
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
