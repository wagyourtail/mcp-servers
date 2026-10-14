#!/usr/bin/env node
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startServer } from "./lib/mcp.ts";
import { fileURLToPath } from "node:url";
import { buildContext } from "./context.ts";
import { registerCompletionTools } from "./tools/completions.ts";
import { registerFileTaskTools } from "./tools/filetasks.ts";
import { registerDelegateTools } from "./tools/delegate.ts";
import { registerWriteTools } from "./tools/writes.ts";
import { registerManageTools } from "./tools/manage.ts";
import { registerDynamicToolTools, loadPersistedDynamicTools } from "./tools/dynamic.ts";
import { registerWhitelistTools } from "./tools/whitelist.ts";
import { registerPrompts } from "./prompts.ts";
import { setRequestTimeout } from "./tools/helpers.ts";

const INSTRUCTIONS = `local_llm is a LOCAL SUBAGENT service: its tools run on a cheap local model
(default Ollama) so YOU don't spend expensive tokens on low-complexity work.

WHEN TO USE:
- Mechanical/monotonous work: summarizing, extracting, classifying, reformatting,
  boilerplate, simple rewrites, batch transforms over many files.
- Bulk file inspection: contents are read SERVER-SIDE, never enter your context —
  only compact results come back (check delegated_bytes in responses).
- run_local_agent delegates a whole task: the local model runs its own tool loop
  (read_file/list_dir/search_files, stage_write/stage_edit, whitelisted
  run_command, verify_staged) and returns only a final answer.
- decide: if a decision model is installed (clef-flash/nimble/tev — check
  list_models for 'decision' capability), prefer it over classify for labeling —
  real probabilities per option in one pass, no parsing.
- NOT for: real reasoning, security-sensitive changes, architecture decisions, or
  anything where a wrong answer is worse than no answer — small models produce
  plausible garbage. verify:"self" adds a critique pass; verify_staged runs a
  whitelisted linter/typecheck against a staged draft.

MODELS:
- No good model? search_models + list_model_tags find one on the ollama registry,
  recommend_model picks what fits detected VRAM, pull_model downloads (job — poll
  with wait {seconds, job_id}).

EDITS, NOT REWRITES:
- For localized changes prefer propose_edit/stage_edit (SEARCH/REPLACE hunks)
  over propose_write/stage_write (whole file) — small models truncate or silently
  drop content regenerating large files. Hunk mismatches fail cleanly.

PRAGMATIC WRITE WORKFLOW:
- Default write_mode "propose": nothing reaches disk and commit_write REFUSES —
  don't call it. Review get_diff and apply with YOUR OWN edit tools so the user's
  native review UI shows the diff. Best for consequential changes.
- Bulk batches (map_files over many files): set_write_mode("write") for the
  batch, review a SAMPLE of diffs with get_diff, verify_staged the risky ones,
  then commit_write each op. commit_write requires 'path' + 'summary' — that's
  all the approval prompt shows, so make it say what is being written.
  revert_write stages an undo; uncommit_write restores pre-commit content
  directly. Set the mode back to "propose" when done.
- Long delegations: sync calls past agent_sync_grace_ms return a job_id instead
  of losing the result; run_async:true returns one immediately. Poll with
  wait {seconds, job_id} (returns early on completion); steer with control_job —
  inject corrections, pause, cancel.

INPUT-SIZING:
- Prefer \`paths\` (agent reads on demand) over \`files\` (inlined) for anything
  large or numerous — the small model's context is small; context_warning tells
  you when you've blown it.
- Pick model by fit: code transforms -> a coder model, general text -> instruct
  models. list_models + get_system_resources tell you what fits VRAM.

Safety model: local-model writes are staged ops only; run_command is
whitelist-only argv-exec (no shell); file access limited to detected+configured
roots; dynamic tools + run_command need env flags.

Workflow hint: call get_server_info first to see providers/roots/flags/mode, and
get_usage_stats at the end of a session to see what you saved.`;

async function main(): Promise<void> {
  const ctx = buildContext();
  setRequestTimeout(ctx.config.limits.request_timeout_s * 1000);
  const loaded = loadPersistedDynamicTools();

  // Root detection: cwd (the project dir Devin spawned us from) unless disabled.
  if (ctx.config.trust_cwd) ctx.guard.addRoot(process.cwd(), "cwd");

  await startServer({
    name: "local_llm",
    instructions: INSTRUCTIONS,
    capabilities: { tools: {}, prompts: {} },
    register: (server) => {
      registerCompletionTools(server, ctx);
      registerFileTaskTools(server, ctx);
      registerDelegateTools(server, ctx);
      registerWriteTools(server, ctx);
      registerManageTools(server, ctx);
      registerDynamicToolTools(server, ctx);
      registerWhitelistTools(server, ctx);
      registerPrompts(server);
    },
    afterConnect: async (server) => {
  // MCP roots capability: if the client advertises workspace roots, add them and
  // keep them in sync via roots/list_changed.
  const clientCaps = server.server.getClientCapabilities() as { roots?: unknown } | undefined;
  if (clientCaps?.roots) {
    const refreshRoots = async (): Promise<void> => {
      try {
        const { roots } = await server.server.listRoots();
        ctx.guard.setRootsForSource(
          "mcp-roots",
          roots
            .filter((r) => r.uri.startsWith("file://"))
            .map((r) => fileURLToPath(r.uri)),
        );
        console.error(`local_llm: mcp roots -> ${ctx.guard.rootList.join(", ")}`);
      } catch (e) {
        console.error("local_llm: roots refresh failed:", e instanceof Error ? e.message : e);
      }
    };
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      void refreshRoots();
    });
    await refreshRoots();
  }

  // Server logs must go to stderr — stdout is the protocol channel.
  console.error(
    `local_llm ready: providers=[${ctx.providers.names().join(", ")}] ` +
      `roots=[${ctx.guard.rootDetails.map((r) => `${r.path}(${r.source})`).join(", ")}] ` +
      `dynamic=${ctx.env.dynamicTools}(${loaded} loaded) run_command=${ctx.env.runCommand}`,
  );
    },
  });
}

main().catch((e) => {
  console.error("local_llm fatal:", e);
  process.exit(1);
});
