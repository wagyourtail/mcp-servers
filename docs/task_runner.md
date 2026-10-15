# `task_runner` tools

> Generated from live registrations by `npm run docs` — do not edit by hand.

Detached long-running processes that survive MCP server restarts — dev servers, watchers, downloads — with per-task logs, process-group kill, stdin, respawn, and regex-aware waiting.

## Server instructions

<details><summary>What MCP clients see at session start (model-facing, terse)</summary>

```
task_runner manages detached LONG-RUNNING processes: build watchers, dev
servers, test loops, downloads — anything you'd otherwise run in a terminal tab
and lose track of.

WHEN TO USE:
- Starting/backgrounding a process you need to keep alive across the session:
  task_start returns an id + log path; stdout+stderr stream to the log file.
- Checking on things later: task_list / task_status / task_log (tailed reads —
  don't poll the whole file).
- Stopping: task_kill signals the whole process group (SIGTERM, SIGKILL after a
  grace period). task_stdin feeds interactive tasks started with stdin:true.
- Waiting: task_wait {id, seconds} returns early when the task exits — use it
  instead of sleep-polling task_status. 'match' (a regex) also returns early
  when a log line matches (e.g. 'listening on :[0-9]+' for a dev server).
- Restarting: task_restart {id} kills + respawns with the recorded argv/cwd/env —
  same id and log. Logs are bounded (pruned past 64MB).

Semantics:
- argv only, no shell — no pipes/redirects/globs. Wrap in ['sh','-c',...] if you
  need them, and know that defeats injection safety.
- Tasks are DETACHED: they survive this server restarting. A restarted server
  reattaches by pid (task_list still shows them; task_stdin won't work on
  reattached tasks — stdin is process-bound).
- Logs live under the state dir (default ~/.local/state/taskd/, override with
  TASKD_STATE_DIR) as <task-id>.log — append-only, not rotated.
```

</details>

## Tools

**8 tools** — 2 ask-tier (approval per call), 6 allow-tier (auto-approved).

### `task_start` `ask`

Start a long-running background task (detached — survives server restarts). argv only, NO shell: no pipes/redirects/globs — wrap in ['sh','-c',...] if needed. stdout+stderr are appended to a per-task log file (see task_log). Returns id + pid + log path.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `argv` | string[] | **yes** | — | Command + args, e.g. ['npm','run','dev'] |
| `name` | string | no | — | Human label for task_list |
| `cwd` | string | no | — | Working directory (default: server cwd) |
| `env` | object | no | — | Extra env vars (merged over process env) |
| `stdin` | boolean | no | — | Keep a stdin pipe open for task_stdin |
| `log` | string | no | — | Log file path (default: per-task file in the taskd state dir). Relative paths resolve against the task cwd; parent dirs are created. Caller-chosen logs are NOT auto-pruned past 64MB. |

### `task_list`

List all tasks known to this server (newest first), including ones reattached after a restart.

_No parameters._

### `task_status`

Status of one task: running/exited/killed/lost, pid, exit code, log path.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |

### `task_log`

Read the tail of a task's combined stdout+stderr log file.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |
| `lines` | integer | no | — | Tail lines (default 200) |
| `max_bytes` | integer | no | — | Read at most this many bytes from the end |

### `task_stdin`

Write text to a task's stdin (only if started with stdin:true and this server still owns it).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |
| `text` | string | **yes** | — | Bytes to write — include \n to submit a line |

### `task_kill`

Signal a task's whole process group (default SIGTERM, SIGKILL after grace_ms if still alive).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |
| `signal` | string | no | — | e.g. SIGTERM (default), SIGINT, SIGHUP, SIGKILL |
| `grace_ms` | integer | no | — | Ms to wait before SIGKILL (default 3000, 0 = never) |

### `task_wait`

Wait up to N seconds for a task to leave 'running' (early return on exit). With `match`, also returns early the moment a log line matches the regex — e.g. 'listening on :\\d+' for a dev server coming up. Final log scan happens after exit/timeout.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |
| `seconds` | number | no | — | Max wait (default 30, cap 600; -1 = until exit) |
| `match` | string | no | — | Regex — return early when a log line matches |

### `task_restart` `ask`

Kill (SIGTERM, grace_ms before SIGKILL) and respawn a task with its recorded argv/cwd/env — same id and log file. Ask-tier like task_start: it launches a process.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | **yes** | — |  |
| `grace_ms` | integer | no | — | Ms to wait before SIGKILL (default 3000) |
