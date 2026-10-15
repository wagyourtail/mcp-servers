// docs — render docs/<server>.md + README server list. Args: [--check] [outdir].
// Rendered from the same registrations the live servers run.
import { assertDeps } from "../shared/preflight.ts";
import { collectAll } from "./_collect.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderServerDocs, renderServersBlock, updateReadmeServers } from "../shared/gendocs.ts";

assertDeps("local_llm");
const rest = process.argv.slice(3);
const check = rest.includes("--check");
const outdir = rest.find((a) => !a.startsWith("--")) ?? "docs";
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
