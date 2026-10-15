import { z } from "zod";
import { jsonResult, type Registrar } from "../shared/mcp.ts";
import type { TaskRegistry } from "./tasks.ts";

export const SUMMARY =
  "Detached long-running processes that survive MCP server restarts — " +
  "dev servers, watchers, downloads — with per-task logs, process-group kill, " +
  "stdin, respawn, and regex-aware waiting.";

export const INSTRUCTIONS = `task_runner manages detached LONG-RUNNING processes: build watchers, dev
servers, test loops, downloads — anything you'd otherwise run in a terminal tab
and lose track of.

WHEN TO USE:
- Starting/backgrounding a process you need to keep alive across the session:
  task_start returns an id + log path; stdout+stderr stream to the log file.
- Checking on things later: task_list / task_status / task_log (tailed reads —
  don't poll the whole file).
- Stopping: task_kill signals the whole process group (SIGTERM, SIGKILL after a
  grace period). task_stdin feeds interactive tasks started with stdin:true.
- Waiting: task_wait {id, seconds} returns early when the task exits — use it
  instead of sleep-polling task_status. 'match' (a regex) also returns early
  when a log line matches (e.g. 'listening on :[0-9]+' for a dev server).
- Restarting: task_restart {id} kills + respawns with the recorded argv/cwd/env —
  same id and log. Logs are bounded (pruned past 64MB).

Semantics:
- argv only, no shell — no pipes/redirects/globs. Wrap in ['sh','-c',...] if you
  need them, and know that defeats injection safety.
- Tasks are DETACHED: they survive this server restarting. A restarted server
  reattaches by pid (task_list still shows them; task_stdin won't work on
  reattached tasks — stdin is process-bound).
- Logs live under the state dir (default ~/.local/state/taskd/, override with
  TASKD_STATE_DIR) as <task-id>.log — append-only, not rotated.`;

/** task_wait cap on explicit `seconds` — matches Devin's 600s server-side default.
 *  TASKD_MAX_WAIT_S overrides; -1 lifts the cap. `seconds:-1` itself always
 *  means "wait until the task exits", uncapped. */
const ENV_WAIT_S = Number(process.env.TASKD_MAX_WAIT_S);
const MAX_WAIT_S = Number.isFinite(ENV_WAIT_S) && ENV_WAIT_S !== 0 ? ENV_WAIT_S : 600;

function meta(t: import("./tasks.ts").TaskMeta): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    argv: t.argv.join(" "),
    cwd: t.cwd,
    pid: t.pid,
    status: t.status,
    exit_code: t.exitCode,
    exit_signal: t.exitSignal,
    started_at: t.startedAt,
    finished_at: t.finishedAt,
    log: t.logPath,
  };
}

export function registerTools(reg: Registrar, tasks: TaskRegistry): void {
  reg.ask(
    "task_start",
    {
      description:
        "Start a long-running background task (detached — survives server restarts). " +
        "argv only, NO shell: no pipes/redirects/globs — wrap in ['sh','-c',...] if needed. " +
        "stdout+stderr are appended to a per-task log file (see task_log). Returns id + pid + log path.",
      inputSchema: {
        argv: z.array(z.string()).min(1).describe("Command + args, e.g. ['npm','run','dev']"),
        name: z.string().optional().describe("Human label for task_list"),
        cwd: z.string().optional().describe("Working directory (default: server cwd)"),
        env: z.record(z.string(), z.string()).optional().describe("Extra env vars (merged over process env)"),
        stdin: z.boolean().optional().describe("Keep a stdin pipe open for task_stdin"),
        log: z.string().optional().describe(
          "Log file path (default: per-task file in the taskd state dir). " +
          "Relative paths resolve against the task cwd; parent dirs are created. " +
          "Caller-chosen logs are NOT auto-pruned past 64MB.",
        ),
      },
    },
    async ({ argv, name, cwd, env, stdin, log }) =>
      jsonResult(meta(tasks.start({ argv, name, cwd, env, stdin, log }))),
  );

  reg.allow(
    "task_list",
    {
      description: "List all tasks known to this server (newest first), including ones reattached after a restart.",
      inputSchema: {},
    },
    async () => jsonResult({ tasks: tasks.list().map(meta) }),
  );

  reg.allow(
    "task_status",
    {
      description: "Status of one task: running/exited/killed/lost, pid, exit code, log path.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`no task ${id}`);
      return jsonResult(meta(t));
    },
  );

  reg.allow(
    "task_log",
    {
      description: "Read the tail of a task's combined stdout+stderr log file.",
      inputSchema: {
        id: z.string(),
        lines: z.number().int().min(1).optional().describe("Tail lines (default 200)"),
        max_bytes: z.number().int().optional().describe("Read at most this many bytes from the end"),
      },
    },
    async ({ id, lines, max_bytes }) => jsonResult({ ...tasks.log(id, lines, max_bytes) }),
  );

  reg.allow(
    "task_stdin",
    {
      description:
        "Write text to a task's stdin (only if started with stdin:true and this server still owns it).",
      inputSchema: {
        id: z.string(),
        text: z.string().describe("Bytes to write — include \\n to submit a line"),
      },
    },
    async ({ id, text }) => {
      tasks.stdin(id, text);
      return jsonResult({ ok: true });
    },
  );

  reg.allow(
    "task_kill",
    {
      description:
        "Signal a task's whole process group (default SIGTERM, SIGKILL after grace_ms if still alive).",
      inputSchema: {
        id: z.string(),
        signal: z.string().optional().describe("e.g. SIGTERM (default), SIGINT, SIGHUP, SIGKILL"),
        grace_ms: z.number().int().min(0).optional().describe("Ms to wait before SIGKILL (default 3000, 0 = never)"),
      },
    },
    async ({ id, signal, grace_ms }) =>
      jsonResult(meta(await tasks.kill(id, signal as NodeJS.Signals | undefined, grace_ms))),
  );

  reg.allow(
    "task_wait",
    {
      description:
        "Wait up to N seconds for a task to leave 'running' (early return on exit). With `match`, " +
        "also returns early the moment a log line matches the regex — e.g. 'listening on :\\\\d+' for " +
        "a dev server coming up. Final log scan happens after exit/timeout.",
      inputSchema: {
        id: z.string(),
        seconds: (MAX_WAIT_S < 0 ? z.number().min(-1) : z.number().min(-1).max(MAX_WAIT_S))
          .describe(`Max wait (default 30, cap ${MAX_WAIT_S < 0 ? "none" : MAX_WAIT_S}; -1 = until exit)`).optional(),
        match: z.string().optional().describe("Regex — return early when a log line matches"),
      },
    },
    async ({ id, seconds, match }) => {
      const r = await tasks.wait(id, seconds ?? 30, match);
      return jsonResult({
        ...meta(r.task),
        ...(r.matched !== undefined ? { matched: r.matched, matched_line: r.matchedLine } : {}),
      });
    },
  );

  reg.ask(
    "task_restart",
    {
      description:
        "Kill (SIGTERM, grace_ms before SIGKILL) and respawn a task with its recorded " +
        "argv/cwd/env — same id and log file. Ask-tier like task_start: it launches a process.",
      inputSchema: {
        id: z.string(),
        grace_ms: z.number().int().min(0).optional().describe("Ms to wait before SIGKILL (default 3000)"),
      },
    },
    async ({ id, grace_ms }) => jsonResult(meta(await tasks.restart(id, grace_ms))),
  );
}
