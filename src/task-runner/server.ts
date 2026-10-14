// task_runner MCP server — manage detached long-running processes.
import { startServer, serverRegistrar } from "../shared/mcp.ts";
import { TaskRegistry } from "./tasks.ts";
import { registerTaskTools } from "./tools.ts";

const INSTRUCTIONS = `task_runner manages detached LONG-RUNNING processes: build watchers, dev
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
  instead of sleep-polling task_status.

Semantics:
- argv only, no shell — no pipes/redirects/globs. Wrap in ['sh','-c',...] if you
  need them, and know that defeats injection safety.
- Tasks are DETACHED: they survive this server restarting. A restarted server
  reattaches by pid (task_list still shows them; task_stdin won't work on
  reattached tasks — stdin is process-bound).
- Logs live under the state dir (default ~/.local/state/taskd/, override with
  TASKD_STATE_DIR) as <task-id>.log — append-only, not rotated.`;

async function main(): Promise<void> {
  const tasks = new TaskRegistry();
  await startServer({
    name: "task_runner",
    instructions: INSTRUCTIONS,
    register: (server) => registerTaskTools(serverRegistrar(server), tasks),
    afterConnect: () => {
      const running = tasks.list().filter((t) => t.status === "running");
      // stderr only — stdout is the protocol channel.
      console.error(
        `task_runner ready: state=${tasks.stateDirPath} ` +
          `reattached=${running.length} running`,
      );
    },
  });
}

main().catch((e) => {
  console.error("task_runner fatal:", e);
  process.exit(1);
});
