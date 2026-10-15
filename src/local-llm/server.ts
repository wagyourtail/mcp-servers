#!/usr/bin/env node
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startServer, serverRegistrar } from "../shared/mcp.ts";
import { fileURLToPath } from "node:url";
import { buildContext } from "./context.ts";
import { INSTRUCTIONS, registerAll } from "./registration.ts";
import { registerPrompts } from "./prompts.ts";
import { loadPersistedDynamicTools } from "./tools/dynamic.ts";
import { setRequestTimeout } from "./tools/helpers.ts";


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
      registerAll(serverRegistrar(server), ctx);
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
