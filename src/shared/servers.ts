// The single server table — index.ts boots `server`, cli.ts runs
// `registration` against a recording registrar for manifest/docs.
// Adding a server = one entry here + a src/<name>/ folder whose registration
// module exports registerTools(reg, ctx), SUMMARY, and INSTRUCTIONS.

// file:// URLs resolved against this file's location — dynamic import()
// resolves against the *importing* file, so plain relative paths break for
// importers outside src/.
const SRC = new URL("../", import.meta.url);

export const SERVERS = {
  local_llm: {
    server: new URL("local-llm/server.ts", SRC).href,
    registration: new URL("local-llm/registration.ts", SRC).href,
  },
  task_runner: {
    server: new URL("task-runner/server.ts", SRC).href,
    registration: new URL("task-runner/tools.ts", SRC).href,
  },
} as const;

export type ServerName = keyof typeof SERVERS;
