/**
 * Interactive config builder for openai-mcp.
 *   node scripts/configure.ts            — wizard (prefills from existing config if present)
 *   node scripts/configure.ts --yes      — accept all defaults, non-interactive
 *   node scripts/configure.ts --out PATH — write config elsewhere
 *   node scripts/configure.ts --clients devin,cursor — install into specific clients ('all'/'none')
 *   node scripts/configure.ts --print-devin — only print the MCP registration JSON
 *   node scripts/configure.ts --no-install — don't offer to write client config files
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const serverPath = join(projectRoot, "src", "index.ts");
const args = argv.slice(2);
const YES = args.includes("--yes");
const PRINT_ONLY = args.includes("--print-devin");
const NO_INSTALL = args.includes("--no-install");
const outIdx = args.indexOf("--out");
const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const outPath =
  outIdx >= 0 ? args[outIdx + 1] : process.env.LOCAL_LLM_CONFIG ?? join(xdg, "openai-mcp", "config.json");
const clientsIdx = args.indexOf("--clients");

const ALLOW_TOOLS = [
  "chat", "complete", "summarize", "extract", "classify", "map_files", "decide",
  "run_local_agent", "list_models", "get_system_resources", "list_staged",
  "get_diff", "discard_write", "get_usage_stats", "list_dynamic_tools",
  "get_command_whitelist", "get_job", "list_jobs", "control_job",
  "get_server_info", "propose_write", "propose_edit", "recommend_model", "list_commits",
  "revert_write", "search_models", "list_model_tags", "wait",
].map((t) => `mcp__local_llm__${t}`);

const ASK_TOOLS = [
  "commit_write", "set_write_mode", "pull_model", "download_model",
  "delete_model", "prune_models", "register_tool", "unregister_tool",
  "update_command_whitelist", "unload_model", "uncommit_write", "verify_staged",
].map((t) => `mcp__local_llm__${t}`);

// task_runner — read-only observation is allow-tier; anything
// that starts/signals/feeds a process is ask-tier.
const TASK_ALLOW = ["task_list", "task_status", "task_log", "task_wait"].map(
  (t) => `mcp__task_runner__${t}`,
);
const TASK_ASK = ["task_start", "task_kill", "task_stdin"].map(
  (t) => `mcp__task_runner__${t}`,
);

interface ProviderDraft {
  type: "ollama" | "openai";
  base_url: string;
  default_model?: string;
  api_key_env?: string;
  num_ctx?: number;
  keep_alive?: string;
  think?: boolean | "low" | "medium" | "high";
  options?: Record<string, unknown>;
}

interface ExistingConfig {
  default_provider?: string;
  providers?: Record<string, ProviderDraft>;
  trust_cwd?: boolean;
  allowed_roots?: string[];
  write_mode?: "propose" | "write";
  limits?: { num_ctx?: number };
  [k: string]: unknown;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  if (existsSync(path)) {
    const backup = `${path}.bak-${Date.now()}`;
    copyFileSync(path, backup);
    console.log(`  (backed up existing -> ${backup})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function probeOllama(url: string): Promise<string[]> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function serverEntry(env: Record<string, string>): object {
  return { command: "node", args: [serverPath], env };
}

function taskdEntry(): object {
  return { command: "node", args: [serverPath, "task_runner"] };
}

// --- MCP client targets -----------------------------------------------------
// Every client stores server registrations as JSON; only the envelope differs.

interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClientSpec {
  key: string;
  label: string;
  /** File holding this client's server registrations. */
  path: string;
  /** Insert our server entries into the file's parsed JSON doc. */
  insert: (doc: Record<string, any>, servers: Record<string, McpEntry>) => void;
  /** If the client has a tool-permission file with allow/ask lists, its path. */
  permsPath?: string;
}

/** Shared mcpServers envelope: devin, claude-code, cursor, windsurf. */
function mcpServersInsert(
  doc: Record<string, any>,
  servers: Record<string, McpEntry>,
): void {
  doc.mcpServers = { ...(doc.mcpServers ?? {}), ...servers };
}

const CLIENTS: ClientSpec[] = [
  {
    key: "devin",
    label: "Devin",
    path: join(xdg, "devin", "mcp_config.json"),
    insert: mcpServersInsert,
    permsPath: join(xdg, "devin", "config.json"),
  },
  {
    key: "claude-code",
    label: "Claude Code",
    path: join(homedir(), ".claude.json"),
    insert: mcpServersInsert,
    // Same mcp__server__tool permission syntax as Devin.
    permsPath: join(homedir(), ".claude", "settings.json"),
  },
  {
    key: "cursor",
    label: "Cursor",
    path: join(homedir(), ".cursor", "mcp.json"),
    insert: mcpServersInsert,
  },
  {
    key: "windsurf",
    label: "Windsurf",
    path: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    insert: mcpServersInsert,
  },
  {
    key: "vscode",
    label: "VS Code",
    path: join(xdg, "Code", "User", "settings.json"),
    insert: (doc, servers) => {
      doc.mcp = doc.mcp ?? {};
      doc.mcp.servers = {
        ...(doc.mcp.servers ?? {}),
        ...Object.fromEntries(
          Object.entries(servers).map(([k, v]) => [k, { type: "stdio", ...v }]),
        ),
      };
    },
  },
  {
    key: "zed",
    label: "Zed",
    path: join(xdg, "zed", "settings.json"),
    insert: (doc, servers) => {
      doc.context_servers = {
        ...(doc.context_servers ?? {}),
        ...Object.fromEntries(
          Object.entries(servers).map(([k, v]) => [
            k,
            { command: { path: v.command, args: v.args }, settings: v.env ?? {} },
          ]),
        ),
      };
    },
  },
];

function clientDetected(c: ClientSpec): boolean {
  // The file, or its directory, existing means the client is plausibly installed.
  return existsSync(c.path) || existsSync(dirname(c.path));
}

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def: string): Promise<string> => {
    if (YES) return def;
    const a = (await rl.question(`${q} [${def}]: `)).trim();
    return a || def;
  };
  const askBool = async (q: string, def: boolean): Promise<boolean> => {
    const a = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
    return a.startsWith("y");
  };

  console.log("openai-mcp config builder\n");

  // --- deps: the server crashes at spawn with ERR_MODULE_NOT_FOUND without them ---
  if (!existsSync(join(projectRoot, "node_modules", "@modelcontextprotocol"))) {
    console.log("node_modules missing — the MCP server can't start without it.");
    const doInstall = YES || (await askBool(`Run npm install in ${projectRoot}?`, true));
    if (doInstall) {
      execFileSync("npm", ["install"], { cwd: projectRoot, stdio: "inherit" });
    } else {
      console.log("  Skipped — run `npm install` yourself before registering the server.");
    }
  }

  // --- update mode: prefill from existing config ---
  const existing = existsSync(outPath) ? readJson<ExistingConfig>(outPath, {}) : {};
  const isUpdate = Object.keys(existing).length > 0;
  if (isUpdate) {
    console.log(`Found existing config at ${outPath} — prefilling (update mode).`);
    console.log(`  providers: ${Object.keys(existing.providers ?? {}).join(", ") || "none"}`);
  }

  const env: Record<string, string> = { LOCAL_LLM_CONFIG: outPath };

  // --- providers ---
  let providers: Record<string, ProviderDraft> = { ...(existing.providers ?? {}) };
  const seen = await probeOllama("http://localhost:11434");
  if (seen.length) console.log(`Detected ollama at localhost:11434 with models: ${seen.join(", ")}`);

  if (isUpdate && Object.keys(providers).length) {
    const rebuild = await askBool("Reconfigure providers from scratch? (n = keep existing)", false);
    if (rebuild) providers = {};
  }
  if (!Object.keys(providers).length) {
    let addMore = true;
    while (addMore) {
      const name = await ask("Provider name", "local");
      const type = (await ask("Type (ollama/openai)", "ollama")) as "ollama" | "openai";
      const base = await ask("Base URL", type === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1");
      const models = type === "ollama" ? await probeOllama(base) : [];
      const defModel =
        models.find((m) => m.includes("coder")) ?? models.find((m) => m.includes("llama3.1:8b")) ?? models.sort((a, b) => a.length - b.length)[0];
      const model = await ask(`Default model${models.length ? ` (installed: ${models.join(", ")})` : ""}`, defModel ?? "llama3.1:8b");
      const p: ProviderDraft = { type, base_url: base, default_model: model };
      const noThink = await askBool(
        "Disable chain-of-thought by default? (recommended: thinking models like qwen3/gpt-oss/gemma4 spend max_tokens on reasoning, which can empty the answer)",
        true,
      );
      if (noThink) p.think = false;
      if (type === "ollama") {
        p.num_ctx = Number(await ask("num_ctx (context window; smaller = less VRAM)", "16384"));
        p.keep_alive = "5m";
      } else {
        const keyEnv = await ask("API key env var name (blank = none)", "");
        if (keyEnv) p.api_key_env = keyEnv;
      }
      providers[name] = p;
      addMore = await askBool("Add another provider?", false);
    }
  }

  // --- roots & posture ---
  const rootsRaw = await ask(
    "allowed_roots (comma-separated extra dirs beyond auto-detected project dir; blank = none)",
    (existing.allowed_roots ?? []).join(","),
  );
  const roots = rootsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const trustCwd = await askBool("Auto-trust the directory Devin launches from (project dir)?", existing.trust_cwd ?? true);
  const writeMode = await ask(
    "Write mode — 'propose' (server only stages diffs; Devin applies) or 'write' (commit_write writes to disk)",
    existing.write_mode ?? "propose",
  );

  // --- feature flags ---
  const runCmd = await askBool("Enable whitelisted run_command for the local agent?", true);
  const dynTools = await askBool("Enable runtime tool registration (dynamic tools)?", true);
  if (runCmd) env.LOCAL_LLM_RUN_COMMAND = "1";
  if (dynTools) env.LOCAL_LLM_DYNAMIC_TOOLS = "1";

  const config = {
    ...existing,
    default_provider: existing.default_provider && providers[existing.default_provider]
      ? existing.default_provider
      : Object.keys(providers)[0],
    providers,
    trust_cwd: trustCwd,
    allowed_roots: roots,
    write_mode: writeMode === "write" ? "write" : "propose",
    limits: { ...(existing.limits ?? {}), num_ctx: existing.limits?.num_ctx ?? 16384 },
  };

  const servers = {
    local_llm: serverEntry(env),
    task_runner: taskdEntry(),
  } as Record<string, McpEntry>;

  if (PRINT_ONLY) {
    console.log("\n--- MCP registration (mcpServers envelope) ---");
    console.log(JSON.stringify({ mcpServers: servers }, null, 2));
    rl.close();
    return;
  }

  writeJson(outPath, config);
  console.log(`\nWrote ${outPath}`);

  // --- client install ---
  const detected = CLIENTS.filter(clientDetected).map((c) => c.key);
  const allKeys = CLIENTS.map((c) => c.key);
  const chosenRaw = clientsIdx >= 0
    ? args[clientsIdx + 1]
    : NO_INSTALL
      ? "none"
      : await ask(
          `Install into which clients? (${allKeys.join("/")}, comma-separated, 'all', or 'none'; detected: ${detected.join(", ") || "none"})`,
          "devin",
        );
  const chosen =
    chosenRaw === "all"
      ? allKeys
      : chosenRaw === "none"
        ? []
        : chosenRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
  for (const key of chosen) {
    const client = CLIENTS.find((c) => c.key === key);
    if (!client) {
      console.log(`  ! unknown client '${key}' — expected one of ${allKeys.join(", ")}`);
      continue;
    }
    const doc = readJson<Record<string, any>>(client.path, {});
    client.insert(doc, servers);
    writeJson(client.path, doc);
    console.log(`Wrote servers -> ${client.path} (${client.label})`);
  }

  // --- permissions (only clients that have allow/ask lists) ---
  const permClients = chosen
    .map((k) => CLIENTS.find((c) => c.key === k))
    .filter((c): c is ClientSpec => !!c?.permsPath);
  const mergePerms =
    permClients.length > 0 &&
    (YES ||
      (await askBool(
        `Merge recommended tool permissions (${permClients.map((c) => c!.label).join(", ")})?`,
        true,
      )));
  if (mergePerms) {
    for (const client of permClients) {
      const cfg = readJson<{ permissions?: { allow?: string[]; ask?: string[] } } & Record<string, unknown>>(
        client!.permsPath!,
        {},
      );
      cfg.permissions = cfg.permissions ?? {};
      const merge = (cur: string[] | undefined, add: string[]): string[] => [
        ...new Set([...(cur ?? []), ...add]),
      ];
      const before = {
        allow: (cfg.permissions.allow ?? []).length,
        ask: (cfg.permissions.ask ?? []).length,
      };
      cfg.permissions.allow = merge(cfg.permissions.allow, [...ALLOW_TOOLS, ...TASK_ALLOW]);
      cfg.permissions.ask = merge(cfg.permissions.ask, [...ASK_TOOLS, ...TASK_ASK]);
      writeJson(client!.permsPath!, cfg);
      console.log(
        `Permissions merged (${client!.label}): allow ${before.allow} -> ${cfg.permissions.allow.length}, ask ${before.ask} -> ${cfg.permissions.ask.length}`,
      );
    }
  }
  rl.close();

  if (!chosen.length) {
    console.log("\n--- MCP registration (manual paste, mcpServers envelope) ---");
    console.log(JSON.stringify({ mcpServers: servers }, null, 2));
  }
  console.log(
    `\nDone.${chosen.length ? ` Registered with: ${chosen.join(", ")}.` : ""} Restart the client(s) to pick up local_llm + task_runner.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
