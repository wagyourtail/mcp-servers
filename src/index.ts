#!/usr/bin/env node
// local_llm entry point: dep preflight, then the real server.
import { assertDeps } from "./shared/preflight.ts";

assertDeps("local_llm");
await import("./local-llm/server.ts");
