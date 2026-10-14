#!/usr/bin/env node
// Entry point: dep preflight, then the real server. Only imports builtins (via
// preflight.ts) so a missing node_modules yields a clear message, not a bare
// ERR_MODULE_NOT_FOUND on the protocol channel.
import { assertDeps } from "./lib/preflight.ts";

assertDeps("local_llm");
await import("./server.ts");
