// Render markdown docs for a server's tools from their recorded registrations
// (`collectManifest` specs). Same source as the live server — docs can't drift.
import type { ToolDoc } from "./mcp.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface JsonParam {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: { type?: string };
  default?: unknown;
  anyOf?: JsonParam[];
}

function typeStr(p: JsonParam): string {
  if (p.enum) return p.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (p.anyOf) return p.anyOf.map(typeStr).join(" \\| ");
  if (p.type === "array") return `${p.items?.type ?? "any"}[]`;
  return p.type ?? "any";
}

function escMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderParams(schema: Record<string, unknown> | undefined): string {
  const props = (schema?.properties ?? {}) as Record<string, JsonParam>;
  const required = new Set((schema?.required ?? []) as string[]);
  const names = Object.keys(props);
  if (!names.length) return "_No parameters._";
  const rows = names.map((n) => {
    const p = props[n];
    const bits = [
      `\`${n}\``,
      typeStr(p),
      required.has(n) ? "**yes**" : "no",
      p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : "—",
      p.description ? escMd(p.description) : "",
    ];
    return `| ${bits.join(" | ")} |`;
  });
  return ["| Param | Type | Required | Default | Description |", "|---|---|---|---|---|", ...rows].join("\n");
}

/** Render one server's doc page: summary + instructions + one section per tool. */
export function renderServerDocs(
  server: string,
  summary: string,
  instructions: string,
  specs: ToolDoc[],
): string {
  const out = [
    `# \`${server}\` tools`,
    "",
    `> Generated from live registrations by \`npm run docs\` — do not edit by hand.`,
    "",
    summary,
    "",
    "## Server instructions",
    "",
    "<details><summary>What MCP clients see at session start (model-facing, terse)</summary>",
    "",
    "```",
    instructions.trim(),
    "```",
    "",
    "</details>",
    "",
    "## Tools",
    "",
    `**${specs.length} tools** — ${specs.filter((s) => s.ask).length} ask-tier (approval per call), ` +
      `${specs.filter((s) => !s.ask).length} allow-tier (auto-approved).`,
    "",
  ];
  for (const s of specs) {
    out.push(`### \`${s.name}\` ${s.ask ? "`ask`" : ""}`.trimEnd());
    out.push("");
    if (s.description) out.push(s.description.trim(), "");
    if (s.doc) out.push(s.doc.trim(), "");
    out.push(renderParams(s.params), "");
  }
  return out.join("\n");
}

const SERVERS_BEGIN = "<!-- GENERATED:SERVERS -->";
const SERVERS_END = "<!-- /GENERATED:SERVERS -->";

export interface ServerEntry {
  name: string;
  summary: string;
  toolCount: number;
  askCount: number;
}

/** Render the README server-list block (contents between the markers). */
export function renderServersBlock(servers: ServerEntry[]): string {
  const lines = servers.map(
    (s) =>
      `- [\`${s.name}\`](docs/${s.name}.md) — ${s.summary} ` +
      `_${s.toolCount} tools, ${s.askCount} ask-tier._`,
  );
  return lines.join("\n");
}

/**
 * Rewrite the marked server-list block in README.md. Returns:
 *  "updated" | "unchanged" | "no-markers" (file or markers absent — skipped).
 */
export function updateReadmeServers(readmePath: string, block: string): "updated" | "unchanged" | "no-markers" {
  if (!existsSync(readmePath)) return "no-markers";
  const md = readFileSync(readmePath, "utf-8");
  const b = md.indexOf(SERVERS_BEGIN);
  const e = md.indexOf(SERVERS_END);
  if (b === -1 || e === -1 || e < b) return "no-markers";
  const inner = `${SERVERS_BEGIN}\n${block}\n${SERVERS_END}`;
  if (md.slice(b, e + SERVERS_END.length) === inner) return "unchanged";
  writeFileSync(readmePath, md.slice(0, b) + inner + md.slice(e + SERVERS_END.length));
  return "updated";
}
