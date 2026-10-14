// local_llm registration surface — single source for both the live server and
// `index.ts --manifest` (which enumerates tools + tiers for permission generation).
// Tool tiers are declared at each tool's own registration via reg.allow/reg.ask.
import type { Registrar } from "../shared/mcp.ts";
import type { ServerContext } from "./context.ts";
import { registerCompletionTools } from "./tools/completions.ts";
import { registerFileTaskTools } from "./tools/filetasks.ts";
import { registerDelegateTools } from "./tools/delegate.ts";
import { registerWriteTools } from "./tools/writes.ts";
import { registerManageTools } from "./tools/manage.ts";
import { registerDynamicToolTools } from "./tools/dynamic.ts";
import { registerWhitelistTools } from "./tools/whitelist.ts";

export function registerAll(reg: Registrar, ctx: ServerContext): void {
  registerCompletionTools(reg, ctx);
  registerFileTaskTools(reg, ctx);
  registerDelegateTools(reg, ctx);
  registerWriteTools(reg, ctx);
  registerManageTools(reg, ctx);
  registerDynamicToolTools(reg, ctx);
  registerWhitelistTools(reg, ctx);
}
