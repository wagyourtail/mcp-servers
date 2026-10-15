// manifest — tool/tier manifest JSON; drives client permissions via configure.
// Same registrations the live servers run.
import { assertDeps } from "../shared/preflight.ts";
import { collectAll } from "./_collect.ts";
import { writeSync } from "node:fs";

assertDeps("local_llm");
const servers = await collectAll();
const manifest = Object.fromEntries(servers.map((s) => [s.name, s.manifest]));
// Synchronous fd write with retry — process.exit can truncate an async
// stdout flush, and writeSync may return early on a non-blocking pipe.
const buf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
for (let off = 0; off < buf.length;) {
  try {
    off += writeSync(1, buf.subarray(off));
  } catch {
    await new Promise((r) => setTimeout(r, 10)); // EAGAIN: wait for the reader
  }
}
process.exit(0);
