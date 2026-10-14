// Shared MCP server bootstrap — one stdio server per process.
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/** Standard tool result: JSON in text + structuredContent. */
export function jsonResult(obj: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    structuredContent: obj,
  };
}

export interface ServerSpec {
  name: string;
  version?: string;
  /** Free-context session instructions — every client sees this without a call. */
  instructions: string;
  capabilities?: Record<string, unknown>;
  /** Register tools/prompts/etc. Runs before transport connect. */
  register: (server: McpServer) => void | Promise<void>;
  /** Runs after connect (client caps known) — e.g. MCP roots sync. */
  afterConnect?: (server: McpServer) => void | Promise<void>;
}

// --- Tool registry -----------------------------------------------------------
// Every tool declares its permission tier at its own registration site via
// reg.allow/reg.ask — the tool name and its default tier can't drift apart.
// `index.ts --manifest` runs the same registration into a recording Registrar
// so scripts/configure.ts derives permission lists from real registrations.

/** registerTool's config arg — generics erased so spec/handler stay concrete. */
export interface ToolSpec {
  title?: string;
  description?: string;
  inputSchema?: ZodRawShapeCompat;
  outputSchema?: ZodRawShapeCompat;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}
export type ToolHandler = ToolCallback<ZodRawShapeCompat>;

export interface Registrar {
  /** Read/observe-only tool — goes on the auto-approved (allow) tier. */
  allow(name: string, spec: ToolSpec, handler: ToolHandler): void;
  /** Mutates disk/state or spends resources — goes on the approval (ask) tier. */
  ask(name: string, spec: ToolSpec, handler: ToolHandler): void;
}

/** Registrar that installs tools on a live MCP server (tier is metadata only). */
export function serverRegistrar(server: McpServer): Registrar {
  const put = (name: string, spec: ToolSpec, handler: ToolHandler): void => {
    server.registerTool(name, spec as never, handler as never);
  };
  return { allow: put, ask: put };
}

export interface ToolManifest {
  tools: string[];
  ask: string[];
}

/**
 * Run a register function against a recording Registrar — no server or
 * transport needed. Register fns must not touch their ctx at registration
 * time (handlers close over it but never run); manifest mode passes stubs.
 */
export function collectManifest(register: (reg: Registrar) => void): ToolManifest {
  const tools: string[] = [];
  const ask: string[] = [];
  register({
    allow: (name) => tools.push(name),
    ask: (name) => {
      tools.push(name);
      ask.push(name);
    },
  });
  return { tools, ask };
}

export async function startServer(spec: ServerSpec): Promise<void> {
  const server = new McpServer(
    { name: spec.name, version: spec.version ?? "0.1.0" },
    {
      instructions: spec.instructions,
      capabilities: spec.capabilities ?? { tools: {} },
    },
  );
  await spec.register(server);
  await server.connect(new StdioServerTransport());
  await spec.afterConnect?.(server);
}
