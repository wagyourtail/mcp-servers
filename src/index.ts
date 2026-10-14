#!/usr/bin/env node
// Multi-server entry: `node src/index.ts [server]` — defaults to local_llm.
// `node src/index.ts --manifest` prints the tool/tier manifest as JSON for
// scripts/configure.ts and exits — permission lists are derived from the same
// registration code the live servers run.
// Only imports builtins (via preflight.ts) so a missing node_modules yields a
// clear message instead of a bare ERR_MODULE_NOT_FOUND on the protocol channel.
import { assertDeps } from "./shared/preflight.ts";

const SERVERS = {
  local_llm: "./local-llm/server.ts",
  task_runner: "./task-runner/server.ts",
} as const;
type ServerName = keyof typeof SERVERS;

const arg = process.argv[2] ?? "local_llm";

if (arg === "--manifest") {
  assertDeps("local_llm");
  const { collectManifest } = await import("./shared/mcp.ts");
  const llm = await import("./local-llm/registration.ts");
  const task = await import("./task-runner/tools.ts");
  // Register fns capture ctx/tasks in handler closures only — stubs never run.
  // Tool tiers come from each registration's reg.allow/reg.ask call.
  const manifest = {
    local_llm: collectManifest((reg) => llm.registerAll(reg, undefined as never)),
    task_runner: collectManifest((reg) => task.registerTaskTools(reg, undefined as never)),
  };
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

if (!(arg in SERVERS)) {
  console.error(`unknown server '${arg}' — expected one of: ${Object.keys(SERVERS).join(", ")}`);
  process.exit(2);
}
const name = arg as ServerName;
assertDeps(name);
await import(SERVERS[name]);
