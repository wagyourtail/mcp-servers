#!/usr/bin/env node
// Multi-server entry: `node src/index.ts [server]` — defaults to local_llm.
// Only imports builtins (via preflight.ts) so a missing node_modules yields a
// clear message instead of a bare ERR_MODULE_NOT_FOUND on the protocol channel.
import { assertDeps } from "./shared/preflight.ts";

const SERVERS = {
  local_llm: "./local-llm/server.ts",
  task_runner: "./task-runner/server.ts",
} as const;
type ServerName = keyof typeof SERVERS;

const arg = process.argv[2] ?? "local_llm";
if (!(arg in SERVERS)) {
  console.error(`unknown server '${arg}' — expected one of: ${Object.keys(SERVERS).join(", ")}`);
  process.exit(2);
}
const name = arg as ServerName;
assertDeps(name);
await import(SERVERS[name]);
