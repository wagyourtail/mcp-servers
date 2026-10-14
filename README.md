# openai-mcp — a local subagent for Devin

An MCP server that lets Devin offload **low-complexity, monotonous work** to a cheap local model
(Ollama by default, or any OpenAI-compatible endpoint) instead of burning frontier tokens on it.

The headline feature is `run_local_agent`: the small model runs its **own tool loop server-side**
(read/search files, run whitelisted commands, stage writes). File contents and intermediate steps
never enter Devin's context — only a compact final answer comes back. Think of it as a local,
free-tier version of Devin's cloud subagents.

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
      "args": ["/path/to/openai-mcp/src/index.ts"],
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

CLI equivalent: `devin mcp add -s user local_llm -- node /path/to/openai-mcp/src/index.ts`

Omit the two `LOCAL_LLM_*` env flags to disable shell access and dynamic tools entirely.

Add `task_runner` the same way: `"task_runner": {"command": "node", "args": ["/path/to/openai-mcp/src/index.ts", "task_runner"]}`. VS Code and Copilot-for-IntelliJ use a `servers` key with `"type": "stdio"` on each entry (`mcp.servers` in VS Code user settings; `~/.local/share/github-copilot/intellij/mcp.json` for Copilot); Zed uses `context_servers` with `{"command": {"path", "args"}, "settings": {}}`. IntelliJ's built-in AI Assistant stores MCP config in IDE options XML — configure it via Settings → Tools → AI Assistant → Model Context Protocol.

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

| Tool | What it does |
|---|---|
| `run_local_agent` | **Local subagent.** Small model runs its own tool loop; returns final answer + staged op ids. `verify:"self"` adds a critique pass. Sync calls wait up to `agent_sync_grace_ms` (default 45s), then return a `job_id` instead of losing the result; `run_async:true` skips the wait and returns a job immediately (poll `get_job`). |
| `chat` | Raw completion passthrough — `prompt`+`system` for one-shot, `messages` for full conversations. |
| `summarize` | Summarize files/globs server-side; only summaries return. |
| `extract` | Structured JSON extraction, optional schema validation + retry. |
| `classify` | Label text/files into candidate labels. |
| `decide` | **Decision models** (ollama `/v1/systemone` — `clef-flash`, `nimble`, `tev`). Scores 1–64 typed questions (`choice`/`score`/`noul`) about a state in one forward pass → calibrated probabilities per option. No generation, no parsing — prefer over `classify` when a decision model is installed. State comes from `state` text or files read server-side. Needs ollama ≥0.40 (`clef-flash` is on the registry: `ollama pull clef-flash`). |
| `map_files` | Apply one instruction across a glob — `report` results or `stage_writes` for review. |
| `propose_write` | Local model rewrites/creates one file → staged diff. |
| `propose_edit` | Patch-style edit: the model returns `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` hunks instead of the whole file; the server applies them to current content and stages the result. Cheaper + safer than `propose_write` for localized changes — a non-matching hunk is a clean error, not a truncated file. |
| `list_staged` / `get_diff` / `commit_write` / `discard_write` | Staged-write lifecycle. **Nothing the local model writes reaches disk without `commit_write`.** Commit refuses if the file drifted since staging (`force=true` overrides) — and entirely while `write_mode` is `propose`. `commit_write` requires `path` + `summary` args so the approval prompt shows *what* is being written, not just an opaque op id; the `path` is verified against the staged op. |
| `set_write_mode` | `propose` (default): server stages diffs only; Devin applies via its own edit tools (`get_diff include_content` for full content). `write`: `commit_write` writes to disk. `persist:true` saves to config. |
| `verify_staged` | Lint/typecheck a staged op **without touching the real file**: content is materialized to a temp file in the same directory (imports resolve), `{file}` in argv substitutes the temp path, runs under the command whitelist, then cleans up. `restore_paths` snapshots/restores side files the checker may rewrite. The local agent gets this too — `run_command` on the real path only sees old disk content. |
| `list_commits` / `revert_write` / `uncommit_write` | Undo: `revert_write(commit_id)` stages a revert op (reviewed path); `uncommit_write(commit_id)` restores pre-commit content immediately in `write` mode (deletes files the commit created; drift-checked). |
| `list_models` | Models per provider (sizes, capabilities, last-modified). |
| `get_system_resources` | RAM + VRAM + loaded models (local ollama only). `ollama_gpu` reports which GPU(s) the server is pinned to (env vars) or observed using (runner process device fds). |
| `recommend_model` | Rank installed models vs detected memory budget (pinned/observed GPU > discrete GPU > RAM) with three-way `fit` verdicts (`yes`/`marginal`/`no`). `apply:true` writes `default_model` to config and applies live; `model:"x:y"` + `apply:true` sets an explicit default. |
| `search_models` | Search the public ollama registry for models — name, description, capability chips (tools/thinking/vision), parameter sizes, installed flag. |
| `list_model_tags` | Pullable tags for a registry model (`gemma4` → `e4b`, `12b`, `26b`, …); `include_sizes:true` fetches real download sizes via the manifest API. |
| `pull_model` | Download a model on ollama — background job, poll `get_job`. |
| `control_job` | Steer a running job: `pause`/`resume`/`cancel`/`inject` (inject = operator instruction the local agent sees next step). |
| `wait_job` | Sleep N seconds (max 600); with `job_id` returns early when the job finishes — poll long pulls/agent runs without busy-looping `get_job`. |
| `download_model` | Download from Hugging Face via `hf` CLI (for llama.cpp/TabbyAPI/vLLM servers). Background job. |
| `unload_model` | Free a model's VRAM. |
| `delete_model` | Permanently delete a model (irreversible). Refuses to delete the provider default or a loaded model without `force:true`. |
| `prune_models` | Bulk-delete old models. `dry_run:true` (default) reports candidates + reclaimable bytes; always keeps `keep[]`, the provider default, loaded models, `keep_recent` newest, `max_age_days` recent pulls, and `unused_days` models used recently (per-model last-used is persisted to `model-usage.json` next to the config — models with no record are kept). |
| `register_tool` / `unregister_tool` / `list_dynamic_tools` | Give the local agent new tools at runtime (`shell` templates or `js` snippets). |
| `get_command_whitelist` / `update_command_whitelist` | Manage what `run_command` may execute. |
| `get_usage_stats` / `get_server_info` | Session savings + effective config. |

Slash commands (MCP prompts): `/mcp__local_llm__delegate <task> [files]` and `/mcp__local_llm__cheap_summary <path> [focus]`.

## task_runner — a second server

This repo also ships `task_runner` (registered by `npm run configure` alongside `local_llm`) — a process manager for long-running background tasks: dev servers, build watchers, downloads, test loops.

| Tool | What it does |
|---|---|
| `task_start` | Spawn a detached process (`argv`, no shell; optional `name`/`cwd`/`env`/`stdin`). Survives server restarts. stdout+stderr append to `<id>.log` in the state dir (`~/.local/state/taskd/`, override `TASKD_STATE_DIR`). |
| `task_list` / `task_status` | All known tasks (reattached after restarts) / one task's status, pid, exit code, log path. |
| `task_log` | Tail the task's combined log (`lines`, `max_bytes`). |
| `task_stdin` | Write to a task's stdin (requires `stdin:true` at start; unavailable on reattached tasks). |
| `task_kill` | Signal the whole process group — SIGTERM default, SIGKILL after `grace_ms`. |
| `task_wait` | Return early when the task exits (up to `seconds`, max 600) — no busy polling. |

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
node src/index.ts   # run the server standalone (stdin MCP)
```
