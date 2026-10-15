#!/usr/bin/env node
// Non-MCP commands (dev/human tooling) — the MCP server entry is index.ts.
//   node src/cli.ts manifest            tool/tier manifest JSON (configure.ts, perms)
//   node src/cli.ts docs [--check] [dir]  render docs/<server>.md + README server list
//   node src/cli.ts task_runner_top     `top` TUI for task_runner (no server needed)
import { assertDeps } from "./shared/preflight.ts";
import { SERVERS } from "./shared/servers.ts";

const cmd = (process.argv[2] ?? "").replace(/^--/, "");
const rest = process.argv.slice(3);

/** Run every server's registration against a recording registrar.
 *  Register fns capture ctx in handler closures only — stubs never run. */
async function collectAll() {
  const { collectManifest } = await import("./shared/mcp.ts");
  const out = [];
  for (const [name, s] of Object.entries(SERVERS)) {
    const mod = (await import(s.registration)) as {
      SUMMARY: string;
      INSTRUCTIONS: string;
      registerTools: (reg: never, ctx: never) => void;
    };
    out.push({
      name,
      summary: mod.SUMMARY,
      instructions: mod.INSTRUCTIONS,
      manifest: collectManifest((reg) => mod.registerTools(reg as never, undefined as never)),
    });
  }
  return out;
}

if (cmd === "manifest") {
  assertDeps("local_llm");
  const servers = await collectAll();
  const manifest = Object.fromEntries(servers.map((s) => [s.name, s.manifest]));
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

if (cmd === "docs") {
  assertDeps("local_llm");
  const check = rest.includes("--check");
  const outdir = rest.find((a) => !a.startsWith("--")) ?? "docs";
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { renderServerDocs, renderServersBlock, updateReadmeServers } = await import("./shared/gendocs.ts");
  const servers = await collectAll();
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

if (cmd === "task_runner_top") {
  // TUI — pure builtins, no deps needed.
  await import("./task-runner/top.ts");
} else {
  console.error(
    `usage: node src/cli.ts <command>\n\n` +
      `  manifest           tool/tier manifest JSON (drives client permissions)\n` +
      `  docs [--check] [dir]  render docs/<server>.md + README server list\n` +
      `  task_runner_top    \`top\` TUI for task_runner tasks\n\n` +
      `MCP servers launch via index.ts: ${Object.keys(SERVERS).join(", ")}`,
  );
  process.exit(cmd ? 2 : 0);
}
