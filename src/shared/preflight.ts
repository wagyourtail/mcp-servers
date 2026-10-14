// Shared entry-point preflight. This file must only import node builtins — it
// runs before any node_modules import so a missing dep tree produces a clear
// stderr message instead of a bare ERR_MODULE_NOT_FOUND on the protocol channel.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function assertDeps(serverName: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(here, "..", "..");
  if (!existsSync(join(projectRoot, "node_modules", "@modelcontextprotocol"))) {
    console.error(
      `${serverName}: dependencies not installed — run \`npm install\` in ${projectRoot} (or \`npm run configure\`, which does it for you), then restart this MCP server.`,
    );
    process.exit(1);
  }
}
