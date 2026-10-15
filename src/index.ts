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
  // Synchronous fd write with retry — process.exit can truncate an async
  // stdout flush, and writeSync may return early on a non-blocking pipe.
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  for (let off = 0; off < buf.length;) {
    try {
      off += writeSync(1, buf.subarray(off));
    } catch {
      await new Promise((r) => setTimeout(r, 10)); // EAGAIN: wait for the reader
    }
  }
  process.exit(0);
}

if (arg === "--docs") {
  // Render docs/<server>.md per server from the same registrations the live
  // servers run. Usage: `node src/index.ts --docs [outdir]` (default: docs/).
  assertDeps("local_llm");
  const check = process.argv.includes("--check");
  const outdir = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "docs";
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { collectManifest } = await import("./shared/mcp.ts");
  const { renderServerDocs, renderServersBlock, updateReadmeServers } = await import("./shared/gendocs.ts");
  const llm = await import("./local-llm/registration.ts");
  const task = await import("./task-runner/tools.ts");
  const servers = [
    { name: "local_llm", summary: llm.SUMMARY, instructions: llm.INSTRUCTIONS, manifest: collectManifest((reg) => llm.registerAll(reg, undefined as never)) },
    { name: "task_runner", summary: task.SUMMARY, instructions: task.INSTRUCTIONS, manifest: collectManifest((reg) => task.registerTaskTools(reg, undefined as never)) },
  ];
  mkdirSync(outdir, { recursive: true });
  let stale = 0;
  for (const s of servers) {
    const path = join(outdir, `${s.name}.md`);
    const md = renderServerDocs(s.name, s.summary, s.instructions, s.manifest.specs);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf-8") !== md) {
        console.error(`stale: ${path} — run \`npm run docs\``);
        stale++;
      }
    } else {
      writeFileSync(path, md);
      console.log(`wrote ${path} (${s.manifest.tools.length} tools)`);
    }
  }
  // README's marked server-list block gets the same treatment.
  const block = renderServersBlock(
    servers.map((s) => ({
      name: s.name,
      summary: s.summary,
      toolCount: s.manifest.tools.length,
      askCount: s.manifest.ask.length,
    })),
  );
  const readmePath = "README.md";
  const BEGIN = "<!-- GENERATED:SERVERS -->", END = "<!-- /GENERATED:SERVERS -->";
  const expected = `${BEGIN}\n${block}\n${END}`;
  const cur = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : "";
  const b = cur.indexOf(BEGIN), e = cur.indexOf(END);
  if (b !== -1 && e > b) {
    if (check) {
      if (cur.slice(b, e + END.length) !== expected) {
        console.error(`stale: ${readmePath} server list — run \`npm run docs\``);
        stale++;
      }
    } else if (updateReadmeServers(readmePath, block) === "updated") {
      console.log(`updated ${readmePath} server list`);
    }
  }
  process.exit(stale ? 1 : 0);
}

if (arg === "top") {
  // TUI: `top` for task_runner tasks — pure builtins, no deps needed.
  await import("./task-runner/top.ts");
} else {
  if (!(arg in SERVERS)) {
    console.error(`unknown server '${arg}' — expected one of: ${Object.keys(SERVERS).join(", ")} (or 'top' for the task TUI)`);
    process.exit(2);
  }
  const name = arg as ServerName;
  assertDeps(name);
  await import(SERVERS[name]);
}
