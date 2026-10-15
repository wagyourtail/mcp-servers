#!/usr/bin/env node
// MCP server entry — `node src/index.ts [server]` defaults to local_llm.
// Dev/human commands (manifest, docs, task_runner_top) live in src/cli.ts.
// Only imports builtins (via preflight.ts) so a missing node_modules yields a
// clear message instead of a bare ERR_MODULE_NOT_FOUND on the protocol channel.
import { assertDeps } from "./shared/preflight.ts";
import { SERVERS, type ServerName } from "./shared/servers.ts";

const arg = process.argv[2] ?? "local_llm";

if (!(arg in SERVERS)) {
  console.error(
    `unknown server '${arg}' — expected one of: ${Object.keys(SERVERS).join(", ")}\n` +
      `dev commands: node src/cli.ts manifest | docs | task_runner_top`,
  );
  process.exit(2);
}
const name = arg as ServerName;
assertDeps(name);
await import(SERVERS[name].server);
