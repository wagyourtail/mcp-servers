# `local_llm` tools

> Generated from live registrations by `npm run docs` — do not edit by hand.

Offloads low-complexity, repetitive work — summarize, extract, classify, bulk file transforms, embeddings, staged edits — to a cheap local model (Ollama or OpenAI-compatible) so the client doesn't spend frontier-model context and tokens on it. Includes a local tool-calling agent, reviewable staged writes, whitelisted command exec, and Ollama model management.

## Server instructions

<details><summary>What MCP clients see at session start (model-facing, terse)</summary>

```
local_llm is a LOCAL SUBAGENT service: its tools run on a cheap local model
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
  with wait_job {seconds, job_id}).

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
  then commit_write ONCE with ops:[{op_id,path,summary}] — one approval prompt
  shows the whole set. commit_write requires 'path' + 'summary' — that's all
  the approval prompt shows, so make it say what is being written.
  revert_write stages an undo; uncommit_write restores pre-commit content
  directly. Set the mode back to "propose" when done.
- Long delegations: sync calls past agent_sync_grace_ms return a job_id instead
  of losing the result; run_async:true returns one immediately. Poll with
  wait_job {seconds, job_id} (returns early on completion); steer with control_job —
  inject corrections, pause, cancel.

INPUT-SIZING:
- Prefer `paths` (agent reads on demand) over `files` (inlined) for anything
  large or numerous — the small model's context is small; context_warning tells
  you when you've blown it.
- Pick model by fit: code transforms -> a coder model, general text -> instruct
  models, similarity/dedup -> embed with an embedding model.
  count_tokens estimates input size (chars/4) before you commit to a big call.
  list_models + get_system_resources tell you what fits VRAM.

Safety model: local-model writes are staged ops only; run_command is
whitelist-only argv-exec (no shell); file access limited to detected+configured
roots; dynamic tools + run_command need env flags.

Workflow hint: call get_server_info first to see providers/roots/flags/mode, and
get_usage_stats at the end of a session to see what you saved.
```

</details>

## Tools

**42 tools** — 12 ask-tier (approval per call), 30 allow-tier (auto-approved).

### `chat`

Chat-completion passthrough to the cheap/local model — cheapest way to offload a small mechanical task. Pass `prompt` (+ optional `system`) for one-shot completions, or `messages` for a full OpenAI-style conversation (few-shot examples, multi-turn).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | no | — | One-shot prompt (use this OR messages) |
| `system` | string | no | — | System prompt prepended when using prompt |
| `messages` | object[] | no | — | OpenAI-style message list (use this OR prompt) |
| `response_format` | `"json"` \| object | no | — | "json" for JSON mode, or a JSON schema for structured output |
| `model` | string | no | — | Model to use (default: provider/config default). Use list_models to see options. |
| `provider` | string | no | — | Provider name from server config (default: default_provider). |
| `temperature` | number | no | — | Sampling temperature (default ~0.2). |
| `max_tokens` | integer | no | — | Max tokens to generate. On thinking models, thinking consumes this budget — pass think:false for short mechanical answers. |
| `num_ctx` | integer | no | — | Context window size (ollama providers only; bounded for VRAM). |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `summarize`

Summarize files or text with the local model. File contents are read server-side and NEVER enter your context — only the summaries come back. Prefer this over reading large files yourself.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `instruction` | string | no | — | What to focus on (default: concise technical summary) |
| `max_chars_per_file` | integer | no | — | Cap each summary length |
| `concurrency` | integer | no | — | Parallel local-LLM requests (default 2) |
| `text` | string | no | — | Inline text instead of files |
| `path` | string | no | — | Single file path (read server-side — never enters your context) |
| `paths` | string[] | no | — | Multiple file paths |
| `glob` | string | no | — | Glob pattern, e.g. 'src/**/*.ts' |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `temperature` | number | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `extract`

Extract structured data from text/files with the local model. Optionally validate output against a JSON schema (one automatic retry on invalid output).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `instruction` | string | **yes** | — | What to extract, e.g. 'all function names and their purposes' |
| `schema` | object | no | — | JSON Schema the result must satisfy |
| `text` | string | no | — | Inline text instead of files |
| `path` | string | no | — | Single file path (read server-side — never enters your context) |
| `paths` | string[] | no | — | Multiple file paths |
| `glob` | string | no | — | Glob pattern, e.g. 'src/**/*.ts' |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `temperature` | number | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `classify`

Classify text/file content into one or more labels with the local model.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `labels` | string[] | **yes** | — | Candidate labels |
| `multi_label` | boolean | no | — | Allow multiple labels (default false) |
| `text` | string | no | — | Inline text instead of files |
| `path` | string | no | — | Single file path (read server-side — never enters your context) |
| `paths` | string[] | no | — | Multiple file paths |
| `glob` | string | no | — | Glob pattern, e.g. 'src/**/*.ts' |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `temperature` | number | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `decide`

Decision-model scoring (ollama /v1/systemone — clef / clef-flash / nimble / tev). Scores 1–64 TYPED questions about a state in ONE forward pass and returns calibrated probabilities per option — no text generation, no output parsing, no retries. Prefer over `classify` when a decision model is available: you get real probabilities instead of parsed JSON. Question types: 'choice' (criteria maps option keys→descriptions, null uses the key), 'score' (numeric scale), 'noul' (true/false). Requires an ollama provider running a decision model; a normal chat model returns an error. State is read server-side — files never enter your context.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `questions` | object | **yes** | — | Named questions, 1–64 |
| `state` | string | no | — | Inline state (plain text or JSON text) |
| `path` | string | no | — | State from a file (read server-side) |
| `paths` | string[] | no | — | Multiple state files |
| `glob` | string | no | — | Glob for state files |
| `model` | string | no | — | Decision model, e.g. 'clef-flash:9b' (default: provider default_model) |
| `provider` | string | no | — |  |

### `map_files`

Run one instruction over many files with the local model (batch job). output='report': get per-file results. output='stage_writes': the model rewrites each file and every change is staged as a diff for your review — NOTHING hits disk until you commit_write.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `glob` | string | **yes** | — | Glob pattern, e.g. 'src/**/*.test.ts' |
| `instruction` | string | **yes** | — | Instruction applied to each file. For stage_writes the model must return the COMPLETE new file content. |
| `output` | `"report"` \| `"stage_writes"` | no | `"report"` |  |
| `max_files` | integer | no | — |  |
| `concurrency` | integer | no | — | Parallel local-LLM requests (default 2) |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `temperature` | number | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `embed`

Embed text/files with an embedding model on the local provider — for semantic dedup, clustering, or find-similar work that generation can't do. Needs an embedding model (e.g. `nomic-embed-text`, `embeddinggemma`) — check list_models capabilities. Returns raw vectors; cosine-similarity them yourself.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | string | no | — | Inline text instead of files |
| `path` | string | no | — | Single file path (read server-side — never enters your context) |
| `paths` | string[] | no | — | Multiple file paths |
| `glob` | string | no | — | Glob pattern, e.g. 'src/**/*.ts' |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |

### `count_tokens`

Estimate token counts for text/files (chars/4 heuristic — ±20% vs a real tokenizer; for input sizing, not billing). Use before run_local_agent/summarize to check fit vs num_ctx.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `text` | string | no | — | Inline text instead of files |
| `path` | string | no | — | Single file path (read server-side — never enters your context) |
| `paths` | string[] | no | — | Multiple file paths |
| `glob` | string | no | — | Glob pattern, e.g. 'src/**/*.ts' |

### `run_local_agent`

Delegate a low-complexity task to the LOCAL SUBAGENT: the cheap model runs its own tool loop (read_file, list_dir, search_files, stage_write, whitelisted run_command, plus any registered dynamic tools) entirely server-side. File contents and intermediate steps never enter your context — you get back a compact final answer + staged-write op ids to review. Use for mechanical, monotonous, or bulk work: finding things, transforming files, answering questions over many files. Do NOT delegate work needing real reasoning, security judgment, or architecture decisions.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `task` | string | **yes** | — | Self-contained task description. The local agent sees ONLY this text + optional context/files — include paths, names, and exactly what to return. |
| `context` | string | no | — | Extra background for the local agent (kept compact). |
| `files` | string[] | no | — | File paths to read server-side and inline into the task (contents bypass your context). Keep this small — it consumes the local model's context window. |
| `paths` | string[] | no | — | File/dir paths to tell the agent about WITHOUT inlining contents — it reads them via tools as needed. Better for many/large files. |
| `allowed_tools` | string[] | no | — | Subset of local tools to permit, e.g. ["read_file","search_files"]. Default: all built-ins + dynamic tools. |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `num_ctx` | integer | no | — | Context window for the local model (ollama only). Smaller = less VRAM. |
| `max_steps` | integer | no | — |  |
| `temperature` | number | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control for the agent's model (ollama `think`). think:false leaves more context/steps for tool calls on thinking models. |
| `options` | object | no | — | Provider-native request overrides (ollama `options` keys / openai body fields). |
| `timeout_s` | integer | no | — |  |
| `verify` | `"none"` \| `"self"` | no | — | "self" = a second local pass critiques the result and flags it needs_review if it looks wrong. |
| `run_async` | boolean | no | — | true = run as a background job; returns job_id immediately, poll get_job for progress + result. false = synchronous, but if the task outlasts config agent_sync_grace_ms the call returns a job_id so the result is never lost. Default: config agent_async. |

### `propose_write`

Have the local model rewrite/create ONE file per your instruction, staged for review. Returns an op id + diff. Nothing is written until commit_write. Use for mechanical rewrites where the file content shouldn't flow through your own context.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | **yes** | — | File to rewrite (existing) or create (new) |
| `instruction` | string | **yes** | — | What the local model should do to the file |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `propose_edit`

Like propose_write, but the local model emits SEARCH/REPLACE hunks instead of the whole file — much more reliable on large files and small models. Server applies the hunks and stages the result as a normal op (same diff/commit flow).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | **yes** | — | File to edit (must exist — use propose_write for new files) |
| `instruction` | string | **yes** | — | What the local model should change |
| `model` | string | no | — |  |
| `provider` | string | no | — |  |
| `num_ctx` | integer | no | — |  |
| `think` | boolean \| `"low"` \| `"medium"` \| `"high"` | no | — | Chain-of-thought control (ollama `think`; best-effort on openai-compatible servers). think:false keeps the whole max_tokens budget for the answer. |
| `top_p` | number | no | — | Nucleus sampling threshold. |
| `seed` | integer | no | — | Fixed seed for reproducible output. |
| `stop` | string[] | no | — | Stop sequences. |
| `options` | object | no | — | Provider-native overrides merged into the request (ollama `options` keys like top_k/repeat_penalty; openai-compatible body fields). Wins over named params. |

### `stage_delete`

Stage a file DELETION for review — nothing touches disk until commit_write. The diff shows all lines removed; uncommit_write restores the file afterwards. Use for dead-code cleanup instead of emptying a file with propose_write.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | **yes** | — | Existing file to delete (must be inside allowed roots) |
| `reason` | string | no | — | One-line rationale shown in review |

### `list_staged`

List pending staged writes (proposed changes not yet on disk).

_No parameters._

### `get_diff`

Show the unified diff for a staged write op.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `op_id` | string | **yes** | — |  |
| `include_content` | boolean | no | — | Also return the full new file content (for applying via your own edit tools in propose mode) |

### `set_write_mode` `ask`

Switch the server's write posture. 'propose' (default): staged writes only — commit_write is refused; you apply diffs with your own tools. 'write': commit_write applies staged ops to disk. persist=true also writes the choice to the server config file.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `mode` | `"propose"` \| `"write"` | **yes** | — |  |
| `persist` | boolean | no | — | Also save to the server config file |

### `commit_write` `ask`

Apply a staged write to disk (atomic: tmp+rename). Call only AFTER reviewing the diff with get_diff. Refuses if the file changed since it was staged — pass force=true to overwrite anyway. Only works when write_mode is 'write' — do NOT call it in 'propose' mode (it refuses and the permission prompt would just show an opaque op_id). `path` and `summary` are REQUIRED because the user's approval prompt only shows tool args — make them say exactly what is being written. Pass `ops: [{op_id, path, summary}]` instead to commit a batch in ONE approval — use it for map_files stage_writes output so the user sees the whole set at once.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `op_id` | string | no | — |  |
| `path` | string | no | — | REQUIRED for single-op: the file this op writes — verified against the staged op so the approval prompt can't lie about the target. |
| `summary` | string | no | — | REQUIRED for single-op: one-line description of the change — the main thing the user sees when approving. |
| `ops` | object[] | no | — | Batch commit: [{op_id, path, summary}] — one approval prompt shows the whole set |
| `force` | boolean | no | — | Commit even if the file changed since staging |

### `verify_staged` `ask`

Run a whitelisted command against a staged write WITHOUT touching the target file: the op's content is materialized to a temp file in the same directory (import/path resolution matches the real file), '{file}' in argv is replaced by the temp path (appended if absent), and the command runs under the command_whitelist. Use it to typecheck/lint a staged op before commit_write — running a checker on the original path sees the OLD on-disk content, not the stage. restore_paths lists files the command may rewrite (e.g. an auto-updated lint baseline) — snapshotted before, restored after. The temp file is always removed.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `op_id` | string | **yes** | — |  |
| `argv` | string[] | **yes** | — | Whitelisted command argv; '{file}' is replaced by the materialized temp path |
| `cwd` | string | no | — | Working directory (must be inside allowed roots); defaults to the file's directory |
| `restore_paths` | string[] | no | — | Files to snapshot and restore after the run (e.g. auto-rewritten baseline files) |
| `timeout_s` | integer | no | — | Command timeout override (default: run_command_timeout_s config) |

### `discard_write`

Drop a staged write op without applying it.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `op_id` | string | **yes** | — |  |

### `list_commits`

List recently committed writes (last 20) — for revert_write.

_No parameters._

### `revert_write`

Undo a committed write: stages a NEW op restoring the pre-commit content (goes through normal review — commit_write applies it).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `commit_id` | string | **yes** | — |  |

### `uncommit_write` `ask`

One-call undo of a committed write — restores the pre-commit content atomically (deletes files the commit created), no re-staging/re-commit needed. Refuses if the file changed since the commit unless force:true. Requires write_mode 'write' — in 'propose' mode use revert_write + commit_write for the reviewed path.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `commit_id` | string | **yes** | — |  |
| `force` | boolean | no | — | Restore even though the file drifted since the commit |

### `list_models`

List models available on a provider. For ollama providers includes size, parameter count, quantization and capabilities — use this plus get_system_resources to pick the biggest model that fits VRAM.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | no | — | Provider name (default: default_provider, or 'all' for every provider) |

### `get_system_resources`

Report host RAM + GPU VRAM and currently-loaded models. Only works for LOCAL ollama providers — returns {unavailable: true} for remote/openai-type providers. Use before picking a model or num_ctx for heavy jobs. Includes `ollama_gpu`: which GPU(s) the ollama server is pinned to (env) or observed using (runner process device fds).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | no | — |  |

### `pull_model` `ask`

Download a model on an ollama provider (e.g. 'qwen2.5-coder:7b'). Runs as a background job — returns a job_id; poll progress with get_job. Only for ollama providers.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | **yes** | — | Model name to pull |
| `provider` | string | no | — |  |

### `search_models`

Search the public ollama registry (ollama.com) for models to pull_model. Returns name, description, capability chips (tools/thinking/vision), available parameter sizes, and whether the family is already installed. Requires internet access.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | **yes** | — | Search terms, e.g. 'coder', 'qwen3 small' |
| `category` | `"tools"` \| `"thinking"` \| `"vision"` \| `"embedding"` \| `"cloud"` | no | — | Filter by capability category |
| `limit` | integer | no | — | Max results (default 12) |
| `provider` | string | no | — | Provider to check installed models against |

### `list_model_tags`

List pullable tags for a model in the ollama registry (e.g. model 'gemma4' -> e4b, 12b, 26b, ...). With include_sizes=true, fetches each tag's download size from the registry manifest API (one request per tag). Requires internet access.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | **yes** | — | Model name without tag, e.g. 'gemma4' |
| `include_sizes` | boolean | no | — | Fetch real download size per tag (slower) |
| `limit` | integer | no | — | Max tags (default 30) |
| `provider` | string | no | — | Provider to check installed models against |

### `download_model` `ask`

Download a model from Hugging Face via the `hf` CLI (for llama.cpp/TabbyAPI/vLLM-style servers where pull_model doesn't apply). Runs as a background job — poll with get_job. e.g. repo 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF' with include '*Q4_K_M*'.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `repo` | string | **yes** | — | HF repo id, e.g. 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF' |
| `include` | string | no | — | Filename glob filter, e.g. '*Q4_K_M*.gguf' |
| `local_dir` | string | no | — | Destination dir (must be inside allowed roots; default: HF cache) |
| `revision` | string | no | — | Branch/tag/commit (default: main) |

### `get_job`

Get status/progress of a background job (e.g. a model pull).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `job_id` | string | **yes** | — |  |

### `list_jobs`

List background jobs (most recent first).

_No parameters._

### `wait_job`

Sleep for a number of seconds (max 600), then return. With job_id, returns early as soon as that job reaches done/error — use to poll pull_model/run_local_agent without busy-looping get_job.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `seconds` | number | **yes** | — | Seconds to wait (fractions allowed) |
| `job_id` | string | no | — | Return early when this job finishes |

### `control_job`

Steer a running background job: pause (halt between agent steps), resume, cancel (aborts in-flight work too), or inject (append an operator instruction the local agent sees on its next step — for course-correcting a run_local_agent mid-flight).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `job_id` | string | **yes** | — |  |
| `action` | `"pause"` \| `"resume"` \| `"cancel"` \| `"inject"` | **yes** | — |  |
| `message` | string | no | — | Required for action=inject |

### `recommend_model`

Analyze installed models against detected hardware and recommend a default_model for a provider. Prefers tool-calling models that fit the target GPU's free VRAM (or free RAM for CPU-only). With apply=true, writes the pick to the provider's default_model in the config file AND applies it live to this server.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | no | — | Provider name (default: default_provider) |
| `apply` | boolean | no | — | Persist the pick to config + apply it live |
| `model` | string | no | — | Explicit model to set as default with apply:true (must be installed; skips auto-pick) |
| `budget_mb` | integer | no | — | Override the detected memory budget in MB (e.g. when sizing against a remote ollama host manually) |

### `delete_model` `ask`

Permanently delete a model from an ollama provider (DELETE /api/delete). Irreversible — the model must be re-pulled to restore. Refuses to delete the provider's default_model or a currently-loaded model unless force=true.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | **yes** | — | Model id to delete, e.g. 'llama3.1:8b' |
| `provider` | string | no | — |  |
| `force` | boolean | no | — | Allow deleting the default/loaded model |

### `prune_models` `ask`

Bulk-delete old models from an ollama provider. dry_run=true (default) only reports candidates. Always keeps: keep[] ids, the provider default_model, currently-loaded models, and the keep_recent most recently modified others. With dry_run=false, deletes the rest.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | no | — |  |
| `dry_run` | boolean | no | `true` |  |
| `keep` | string[] | no | — | Model ids to never delete |
| `keep_recent` | integer | no | — | Also keep this many most-recently-modified models (default 0) |
| `max_age_days` | number | no | — | Keep models modified within the last N days |
| `unused_days` | number | no | — | Keep models with a recorded inference within N days (uses the model-usage ledger; models with no record are kept) |

### `unload_model` `ask`

Unload a model from VRAM on an ollama provider (frees memory immediately).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | **yes** | — |  |
| `provider` | string | no | — |  |

### `get_usage_stats`

Session totals: local LLM calls, tokens consumed on the cheap model, and delegated_bytes (bytes of file content processed server-side that never entered your context — i.e. the savings).

_No parameters._

### `get_server_info`

Show this server's config: providers (sanitized), allowed_roots, feature flags, limits. Call this first if unsure what's configured.

_No parameters._

### `register_agent_tool` `ask`

Register a NEW tool that the local model can call during run_local_agent (persists for this server session; persist=true saves it across restarts). kind='shell': an executable + argv template with ${param} placeholders (execFile, no shell). kind='js': a JS function body run in node:vm as (body)(args). Requires LOCAL_LLM_DYNAMIC_TOOLS=1 on the server.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | **yes** | — | Tool name, ^[a-zA-Z0-9_-]{1,64}$ |
| `description` | string | **yes** | — | What it does — the local model picks tools by this text |
| `input_schema` | object | **yes** | — | JSON Schema object for the parameters (type:'object', properties, required) |
| `kind` | `"shell"` \| `"js"` | **yes** | — |  |
| `command` | string | no | — | shell kind: executable name/path |
| `args_template` | string[] | no | — | shell kind: argv template, e.g. ["--format", "${fmt}", "${input}"] |
| `body` | string | no | — | js kind: function source, e.g. '(args) => args.a + args.b' |
| `persist` | boolean | no | — | Save to dynamic_tools.json so it survives restarts |

### `unregister_agent_tool` `ask`

Remove a runtime-registered dynamic tool.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | **yes** | — |  |

### `list_agent_tools`

List runtime-registered tools available to the local agent.

_No parameters._

### `get_command_whitelist`

Show which commands the local agent's run_command tool may execute (argv-level whitelist, no shell).

_No parameters._

### `update_command_whitelist` `ask`

Add/remove commands the local agent may run. Writes the server config file — prefer tight allow_args over broad access. This tool should stay in Devin's 'ask' permissions.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `add` | object[] | no | — |  |
| `remove` | string[] | no | — |  |
