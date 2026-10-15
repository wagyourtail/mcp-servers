#!/usr/bin/env node
// Non-MCP commands (dev/human tooling) — MCP servers launch via index.ts.
//
// Commands are files, no registration:
//   src/cli/<cmd>.ts            → `cli.ts <cmd>`            (global)
//   src/<server>/cli/<cmd>.ts   → `cli.ts <server>_<cmd>`   (per-server)
// A command file runs on import; its first `//` comment line is its help text.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVERS } from "./shared/servers.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

interface Cmd {
  name: string;
  path: string;
  desc: string;
  group: string;
}

/** First `//` comment line of a command file — its help text. */
function descOf(path: string): string {
  try {
    const line = readFileSync(path, "utf-8").split("\n").find((l) => l.trim().startsWith("//"));
    return line?.replace(/^\s*\/\/\s*/, "").split("—").slice(1).join("—").trim() ?? "";
  } catch {
    return "";
  }
}

function scan(dir: string, group: string, prefix: string): Cmd[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      return { name: prefix + f.slice(0, -3), path, desc: descOf(path), group };
    });
}

function discover(): Cmd[] {
  const cmds = scan(join(SRC, "cli"), "global", "");
  for (const srv of Object.keys(SERVERS)) {
    cmds.push(...scan(join(SRC, srv.replace(/_/g, "-"), "cli"), srv, `${srv}_`));
  }
  return cmds;
}

const cmd = (process.argv[2] ?? "").replace(/^--/, "");
const cmds = discover();
const hit = cmds.find((c) => c.name === cmd);

if (hit) {
  await import(hit.path);
} else {
  const groups = new Map<string, Cmd[]>();
  for (const c of cmds) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group)!.push(c);
  }
  const lines = [`usage: node src/cli.ts <command> [args]`, ""];
  for (const [g, list] of groups) {
    lines.push(`${g}:`);
    const w = Math.max(...list.map((c) => c.name.length));
    for (const c of list) lines.push(`  ${c.name.padEnd(w)}  ${c.desc}`);
    lines.push("");
  }
  lines.push(`MCP servers launch via index.ts: ${Object.keys(SERVERS).join(", ")}`);
  console.error(lines.join("\n"));
  process.exit(cmd ? 2 : 0);
}
