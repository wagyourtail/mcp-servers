// Shared helper for cli commands — runs every server's registration against a
// recording registrar. Register fns capture ctx in handler closures only, so
// the stub ctx is never invoked.
import { collectManifest } from "../shared/mcp.ts";
import { SERVERS } from "../shared/servers.ts";

export async function collectAll() {
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
