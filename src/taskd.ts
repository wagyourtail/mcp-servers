#!/usr/bin/env node
// task_runner entry point: dep preflight, then the real server.
import { assertDeps } from "./shared/preflight.ts";

assertDeps("task_runner");
await import("./task-runner/server.ts");
