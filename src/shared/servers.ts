// The single server table — index.ts boots `server`, cli.ts runs
// `registration` against a recording registrar for manifest/docs.
// Adding a server = one entry here + a src/<name>/ folder whose registration
// module exports registerTools(reg, ctx), SUMMARY, and INSTRUCTIONS.

// Paths are relative to src/ — consumers (index.ts, cli.ts) live there and
// dynamic import() resolves against the importing file, not this one.
export const SERVERS = {
  local_llm: {
    server: "./local-llm/server.ts",
    registration: "./local-llm/registration.ts",
  },
  task_runner: {
    server: "./task-runner/server.ts",
    registration: "./task-runner/tools.ts",
  },
} as const;

export type ServerName = keyof typeof SERVERS;
