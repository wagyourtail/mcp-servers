// task_runner MCP server — manage detached long-running processes.
import { startServer, serverRegistrar } from "../shared/mcp.ts";
import { TaskRegistry } from "./tasks.ts";
import { INSTRUCTIONS, registerTaskTools } from "./tools.ts";

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
