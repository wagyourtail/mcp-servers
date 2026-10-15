// Render markdown docs for a server's tools from their recorded registrations
// (`collectManifest` specs). Same source as the live server — docs can't drift.
import type { ToolDoc } from "./mcp.ts";

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
