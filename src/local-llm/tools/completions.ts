import type { Registrar } from "../../shared/mcp.ts";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { pickModel } from "../context.ts";
import { GEN_PARAMS, jsonResult, trackedChat } from "./helpers.ts";

const COMMON = {
  model: z.string().optional().describe("Model to use (default: provider/config default). Use list_models to see options."),
  provider: z.string().optional().describe("Provider name from server config (default: default_provider)."),
  temperature: z.number().optional().describe("Sampling temperature (default ~0.2)."),
  max_tokens: z.number().int().optional().describe("Max tokens to generate. On thinking models, thinking consumes this budget — pass think:false for short mechanical answers."),
  num_ctx: z.number().int().optional().describe("Context window size (ollama providers only; bounded for VRAM)."),
  ...GEN_PARAMS,
};

export function registerCompletionTools(reg: Registrar, ctx: ServerContext): void {
  reg.allow(
    "chat",
    {
      description:
        "Chat-completion passthrough to the cheap/local model — cheapest way to offload a small " +
        "mechanical task. Pass `prompt` (+ optional `system`) for one-shot completions, or " +
        "`messages` for a full OpenAI-style conversation (few-shot examples, multi-turn).",
      inputSchema: {
        prompt: z.string().optional().describe("One-shot prompt (use this OR messages)"),
        system: z.string().optional().describe("System prompt prepended when using prompt"),
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            }),
          )
          .optional()
          .describe("OpenAI-style message list (use this OR prompt)"),
        response_format: z
          .union([z.literal("json"), z.record(z.string(), z.unknown())])
          .optional()
          .describe('"json" for JSON mode, or a JSON schema for structured output'),
        ...COMMON,
      },
    },
    async ({ prompt, system, messages, response_format, model, provider: pName, temperature, max_tokens, num_ctx, think, top_p, seed, stop, options }) => {
      const msgs =
        messages ??
        (prompt !== undefined
          ? [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              { role: "user" as const, content: prompt },
            ]
          : undefined);
      if (!msgs?.length) throw new Error("chat requires `prompt` or `messages`");
      const { provider, model: m } = pickModel(ctx, pName, model);
      const { res, usage } = await trackedChat("chat", provider, {
        model: m,
        messages: msgs,
        temperature,
        max_tokens,
        num_ctx,
        think,
        top_p,
        seed,
        stop,
        options,
        response_format,
      });
      return jsonResult({
        content: res.content,
        ...(res.thinking ? { thinking: res.thinking } : {}),
        finish_reason: res.finishReason,
        usage,
      });
    },
  );
}
