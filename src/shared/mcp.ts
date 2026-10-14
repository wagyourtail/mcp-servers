// Shared MCP server bootstrap — one stdio server per process.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
