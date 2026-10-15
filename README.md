# mcp-servers — a personal MCP server collection

A repo of MCP servers for Devin and other MCP clients (Claude Code, Cursor, Windsurf,
VS Code, Zed, Junie, Copilot for IntelliJ). One entry point — `node src/index.ts <server>`
— serves any of them; `npm run configure` registers them into your clients.
Per-server tool reference lives in [docs/](docs/) and is generated from the live
tool registrations (`npm run docs`).

## Servers

<!-- GENERATED:SERVERS -->
- [`local_llm`](docs/local_llm.md) — Offloads low-complexity, repetitive work — summarize, extract, classify, bulk file transforms, embeddings, staged edits — to a cheap local model (Ollama or OpenAI-compatible) so the client doesn't spend frontier-model context and tokens on it. Includes a local tool-calling agent, reviewable staged writes, whitelisted command exec, and Ollama model management. _42 tools, 12 ask-tier._
- [`task_runner`](docs/task_runner.md) — Detached long-running processes that survive MCP server restarts — dev servers, watchers, downloads — with per-task logs, process-group kill, stdin, respawn, and regex-aware waiting. _8 tools, 2 ask-tier._
<!-- /GENERATED:SERVERS -->

## local_llm

The headline server: offload **low-complexity, monotonous work** to a cheap local model
(Ollama by default, or any OpenAI-compatible endpoint) instead of burning frontier tokens on it.

Its headline feature is `run_local_agent`: the small model runs its **own tool loop server-side**
(read/search files, run whitelisted commands, stage writes). File contents and intermediate steps
never enter the client's context — only a compact final answer comes back. Think of it as a local,
free-tier version of cloud subagents.

## Why it actually saves tokens

- **Server-side file I/O.** `summarize`, `extract`, `map_files`, and `run_local_agent` take
  paths/globs and read files inside the server process. A 200KB file summarized this way costs
  Devin ~500 tokens instead of ~60k.
- **Compact results.** Tool results, diffs, and agent steps are truncated/capped before returning.
- **Visible savings.** Every response reports `usage` and `delegated_bytes` — bytes processed
  that never entered Devin's context. `get_usage_stats` totals it for the session.

## Requirements

- Node **>= 22.18** (runs TypeScript natively — no build step). Verified on Node 26.
- Ollama (`ollama serve`) for the default provider, or any OpenAI-compatible `/v1` endpoint.
- `rg` (ripgrep) is optional — `search_files` uses it when installed and falls back to a built-in walker (gitignore-aware, hidden/binary skipped) when it isn't.
- `nvtop` (optional) for the best GPU detection — all vendors + per-process usage; falls back to `nvidia-smi`/`rocm-smi`.

## Setup

### 1. Server config

```bash
npm install           # required once — the server refuses to start without node_modules
npm run configure     # interactive wizard: runs `npm install` itself if node_modules is missing,
                      # probes ollama, writes ~/.config/openai-mcp/config.json, prefills from an
                      # existing config (update mode), then covers steps 2 & 3 below — installs the
                      # server into ~/.config/devin/mcp_config.json AND merges recommended
                      # permissions into ~/.config/devin/config.json (backs both up first)
# or: npm install && cp config.example.json ~/.config/openai-mcp/config.json  (edit by hand)
```

**File roots are auto-detected.** Effective roots = `allowed_roots` (config) ∪ workspace roots the
MCP client advertises (the spec's `roots` capability) ∪ the directory Devin spawned the server from
(= your project dir, controlled by `trust_cwd: true`). So file tools work out of the box inside the
project, and `allowed_roots` is for *extra* directories outside it. `deny_globs` blocks secrets
everywhere. `get_server_info` shows each root with its source.

### 2. Register with your MCP client

*`npm run configure` does this for you — it detects and offers Devin, Claude Code, Cursor, Windsurf, VS Code, Zed, Junie (JetBrains), and Copilot-for-IntelliJ (`--clients devin,cursor`, `all`, or `none`). Shown here for manual setup — the `mcpServers` envelope works in Devin, Claude Code, Cursor, Windsurf, and Junie as-is.*

**Devin settings → MCP → Add custom MCP** (or edit `~/.config/devin/mcp_config.json`):

```json
{
  "mcpServers": {
    "local_llm": {
      "command": "node",
      "args": ["/path/to/mcp-servers/src/index.ts"],
      "env": {
        "LOCAL_LLM_CONFIG": "~/.config/openai-mcp/config.json",
        "LOCAL_LLM_RUN_COMMAND": "1",
        "LOCAL_LLM_DYNAMIC_TOOLS": "1"
      }
    }
  }
}
```

Provider entries also accept `think` (bool or `"low"/"medium"/"high"`), `options`
(provider-native request overrides), `temperature`, `num_ctx`, and `keep_alive` — defaults applied
to every call; per-request args override them. The `configure` wizard asks about `think` since
thinking-capable models can eat the whole `max_tokens` budget.

CLI equivalent: `devin mcp add -s user local_llm -- node /path/to/mcp-servers/src/index.ts`

Omit the two `LOCAL_LLM_*` env flags to disable shell access and dynamic tools entirely.

Add `task_runner` the same way: `"task_runner": {"command": "node", "args": ["/path/to/mcp-servers/src/index.ts", "task_runner"]}`. VS Code and Copilot-for-IntelliJ use a `servers` key with `"type": "stdio"` on each entry (`mcp.servers` in VS Code user settings; `~/.local/share/github-copilot/intellij/mcp.json` for Copilot); Zed uses `context_servers` with `{"command": {"path", "args"}, "settings": {}}`. IntelliJ's built-in AI Assistant stores MCP config in IDE options XML — configure it via Settings → Tools → AI Assistant → Model Context Protocol.

### 3. Recommended Devin permissions

*`npm run configure` merges these for you (with a backup) — shown here for manual setup.*

In `~/.config/devin/config.json` (or `~/.claude/settings.json` — same syntax):

```json
{
  "permissions": {
    "allow": ["mcp__local_llm__chat", "mcp__local_llm__summarize", "…", "mcp__task_runner__task_kill"],
    "ask":   ["mcp__local_llm__commit_write", "…", "mcp__task_runner__task_start"]
  }
}
```

The lists aren't hardcoded: each tool declares its tier at registration (`reg.allow`
/ `reg.ask` in `src/*/tools/`), and `node src/index.ts --manifest` emits the full
`{tools, ask}` map the configure script merges. `ask` = approve button before writes
hit disk, models download, or processes spawn. Everything else is allow-tier;
`task_start` is task_runner's only ask tool — kill/stdin/wait are scoped to
registry-managed tasks.

## Tools

> Full per-tool reference — descriptions, parameters, types, defaults — is generated
> from the live registrations: [docs/local_llm.md](docs/local_llm.md) and
> [docs/task_runner.md](docs/task_runner.md) (`npm run docs` regenerates;
> `npm run docs:check` verifies freshness).

Tools group by job:

- **Delegate** — `run_local_agent` (local model runs its own tool loop on the task),
  `chat`, `summarize`, `extract`, `classify`, `decide` (calibrated decision
  models, no generation), `map_files` (one instruction across a glob),
  `embed`, `count_tokens`.
- **Staged writes** — `propose_write`/`propose_edit`/`stage_delete` produce
  reviewable diffs; `commit_write` (incl. batch `ops:[...]`) / `discard_write`
  settle them; `set_write_mode` gates whether commits reach disk;
  `verify_staged` lints a draft in a temp file; undo via `list_commits`,
  `revert_write`, `uncommit_write`. **Nothing reaches disk without commit_write.**
- **Models** — `list_models`, `search_models`, `list_model_tags`,
  `recommend_model` (VRAM/RAM-aware, `apply:true` sets default), `pull_model`,
  `download_model`, `unload_model`, `delete_model`, `prune_models`,
  `get_system_resources`.
- **Jobs** — `get_job`, `list_jobs`, `wait_job`, `control_job` (pause/inject/cancel
  long pulls and agent runs).
- **Agent tools & exec policy** — `register_agent_tool`/`unregister_agent_tool`/
  `list_agent_tools` (runtime tools for the local agent only),
  `get_command_whitelist`/`update_command_whitelist`.
- **Meta** — `get_server_info` (providers/roots/flags — call first),
  `get_usage_stats` (session savings).

Slash commands (MCP prompts): `/mcp__local_llm__delegate <task> [files]` and `/mcp__local_llm__cheap_summary <path> [focus]`.

## task_runner — a second server

This repo also ships `task_runner` (registered by `npm run configure` alongside `local_llm`) — a process manager for long-running background tasks: dev servers, build watchers, downloads, test loops.

- `task_start` spawns a detached process (`argv` — no shell; optional `name`/`cwd`/`env`/`stdin`/`log`). `task_list`/`task_status`/`task_log` inspect it, `task_stdin` feeds it, `task_kill` signals the whole process group, `task_restart` respawns the recorded spec, and `task_wait` returns early on exit or a log-regex `match` (`seconds:-1` waits uncapped). `task_start`/`task_restart` are ask-tier; the rest are allow-tier. Full reference: [docs/task_runner.md](docs/task_runner.md).

Log files are append-only but bounded — past 64MB the log is pruned to its last 8MB with a marker line (safe against concurrent writers; children append at EOF). Logs at a caller-chosen `log` path are never pruned.

Both servers launch through one entry: `node src/index.ts` (defaults to `local_llm`) or `node src/index.ts task_runner`. Server code lives in `src/local-llm/` and `src/task-runner/`; `src/shared/` (`preflight.ts` dep-check + `mcp.ts` bootstrap) is the common kit — add another server by writing `src/<name>/server.ts` and one line in `index.ts`'s `SERVERS` map.

## Generation params

Every generation tool accepts these on top of `model`/`provider`/`temperature`/`num_ctx`/`max_tokens`:

| Param | Effect |
|---|---|
| `think` | Chain-of-thought control: `true`/`false`, or `"low"`/`"medium"`/`"high"` on models with effort levels. Maps to ollama's `think`; on openai-compatible servers `false` → `chat_template_kwargs.enable_thinking` (vLLM/llama.cpp convention), a level → `reasoning_effort`. |
| `top_p`, `seed`, `stop` | Standard sampling controls. |
| `options` | Provider-native override bag — merged into ollama `options` (`top_k`, `repeat_penalty`, …) or the openai-compat request body. Wins over the named params. |

Set defaults per provider in config: `"think": false`, `"options": {"top_k": 20}`. Request args
override them.

**Thinking models eat `max_tokens`.** On thinking-capable models (gemma4, qwen3, gpt-oss) a tight
`max_tokens` can be consumed entirely by reasoning, returning empty `text`. Fix per call with
`think:false`, or globally per provider with `"think": false`. `chat` returns the model's
`thinking` trace when the provider reports it, so the budget usage is observable.
(`run_local_agent` accepts `think`/`options` too — disabling think leaves more context and steps
for tool calls.)

## Progress

Two free/cheap progress channels:
- **MCP `notifications/progress`**: `run_local_agent` reports each agent step and `map_files`
  reports per-file completion — *if* the client attaches a `progressToken`. These go to client UI
  plumbing, **not into the model context — zero token cost.**
- **Job polling**: every `run_local_agent` call runs under a job. `run_async:true` returns the
  `job_id` immediately; sync calls return the inline result if they finish within
  `agent_sync_grace_ms`, otherwise the `job_id`. `get_job` shows live progress + the final
  `result`. Polling costs a few tokens per call, but only when Devin chooses to check.
  (`pull_model`/`download_model` are always jobs.)

## Safety model

- **Staged writes + write modes**: local-model output lands in a review queue, never directly on disk.
  Default `write_mode: "propose"` means the server *never* writes — Devin reviews `get_diff` and applies
  through its own edit tools, so changes go through Devin's native file-review flow (at the cost of the
  diff/content tokens). `set_write_mode("write")` (or `write_mode: "write"` in config) lets
  `commit_write` apply server-side — those bypass Devin's edit-review UI but stay git-visible. The
  required `path`/`summary` args keep the `ask`-permission prompt meaningful, and
  `commit_write`/`set_write_mode` belong in `ask` permissions either way.
- **`run_command`**: whitelist-only, executed via `execFile` argv — **no shell**, so `;`, `&&`, `|`, `>`
  are literal arguments and can't inject. `allow_args` constrains subcommands (e.g. git → read-only verbs).
- **File scope**: union of configured `allowed_roots` + MCP-advertised workspace roots + cwd
  (disable with `trust_cwd: false`), minus `deny_globs` for secrets.
- **VRAM**: ollama calls set `num_ctx` explicitly (default 16384) — an unbounded context blew up the
  KV-cache allocation on a 16GB GPU. `get_system_resources` + `unload_model` help manage memory.
- **Honesty**: the instructions tell Devin *not* to delegate anything where a plausible-but-wrong answer
  is worse than no answer. 8B models produce garbage sometimes — `verify:"self"` and staged diffs
  are the mitigations, not a guarantee.

## Provider config

Two types:
- `ollama` → native `/api` (chat with `num_ctx`/`keep_alive`/tools, pull, ps, unload, delete). Local or remote.
- `openai` → generic `/v1` (chat completions, list models). Works with LM Studio, vLLM, llama.cpp,
  OpenAI proper (`api_key_env` references an env var — never store keys in the file).

### Multi-GPU hosts

GPU detection prefers `nvtop -s` (all vendors + per-process usage), falling back to
`nvidia-smi`/`rocm-smi`. **GPUs are identified by PCI bus id** — tool enumeration order is not
trusted (nvtop order ≠ DRM cardN ≠ lspci order on multi-vendor hosts). Each GPU is bound to its
`/sys/class/drm/cardN` entry via PCI match or device-name matching, so `pciSlot`/`driver` are always
correct; missing VRAM is filled from sysfs `mem_info_vram_*` (i915/xe/amdgpu) or ollama's own
discovery log.

`get_system_resources` returns an `ollama_gpu` block describing where the server runs:

- `env` + `env_source` — GPU pinning vars discovered from the `ollama serve` process env
  (`env_source: "proc"`), falling back to the systemd unit (`Environment=`/`EnvironmentFile`,
  `"systemd"`) or the journal's `server config env=map[...]` line (`"journal"`). Cross-user
  `/proc` denial is reported in `env_note` rather than silently yielding an empty env.
- `pinned_indices`/`pinned_slots` — numeric selectors resolved to PCI slots through the journal's
  `inference compute` device table (e.g. `GGML_VK_VISIBLE_DEVICES=2` → the Vulkan device whose
  `pci_id` matches index 2).
- `runners`/`gpus_in_use` — loaded runner processes attributed to GPUs via `/proc/<pid>/fd`
  device nodes, keyed on PCI slot.
- `inference_devices` — devices ollama discovered (`name`, `pci_id`, `total`/`available` VRAM) —
  authoritative for backends nvtop can't measure (e.g. Intel Arc via Vulkan).

To pin ollama to a specific card — e.g. an A380 while a P100 stays reserved for a vLLM server —
set the backend-appropriate selector on `ollama serve` (`GGML_VK_VISIBLE_DEVICES=N` for llama.cpp
Vulkan/Intel Arc, `CUDA_VISIBLE_DEVICES=N` NVIDIA, `HIP_VISIBLE_DEVICES`/`ROCR_VISIBLE_DEVICES`
AMD, `ONEAPI_DEVICE_SELECTOR=level_zero:N` Intel SYCL) in its unit's `EnvironmentFile`, restart
ollama, then `get_system_resources` shows the pin and `recommend_model` sizes its budget against
*that* GPU — never a roomier GPU ollama can't use.

Quick single-provider env mode (no config file): `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_API_KEY_ENV`,
`LOCAL_LLM_MODEL`, `LOCAL_LLM_PROVIDER_TYPE`.

### llama.cpp / exllamav3 / vLLM

These already work — their servers (`llama-server`, TabbyAPI, vLLM) all expose an
OpenAI-compatible `/v1`, so just add `type: "openai"` provider entries:

```json
"llamacpp": { "type": "openai", "base_url": "http://localhost:8080/v1", "default_model": "local-model" },
"tabby":    { "type": "openai", "base_url": "http://localhost:5000/v1", "api_key_env": "TABBY_API_KEY" }
```

What you lose vs. `ollama`-type providers: no `num_ctx` control (llama.cpp uses `-c` at launch),
no `pull`/`ps`/`unload` management, and no system-resources introspection for remote hosts.
`download_model` fills the acquisition gap — it runs `hf download` as a job (requires the `hf` CLI
from `huggingface_hub`). Note `llama-server` can't hot-load a downloaded GGUF without a restart;
TabbyAPI can load via its own admin endpoints.

## Dev

```bash
npm install
npm test            # unit tests (node:test)
npm run smoke       # end-to-end: spawns server, hits real ollama
npm run build       # optional: emit dist/ for node<22.18 or distribution
npm run docs        # regenerate docs/<server>.md from live tool registrations
npm run docs:check  # fail if docs/ is stale (CI)
node src/index.ts   # run the server standalone (stdin MCP)
```
