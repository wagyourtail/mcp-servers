import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../src/local-llm/providers/ollama.ts";
import { OpenAICompatProvider } from "../src/local-llm/providers/openai-compat.ts";

const ollama = () =>
  new OllamaProvider("local", { type: "ollama", base_url: "http://localhost:11434" });
const openai = () =>
  new OpenAICompatProvider("remote", { type: "openai", base_url: "http://x" });

function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify(handler(url, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("ollama embed posts {model, input[]} to /api/embed", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const restore = stubFetch((url, body) => {
    seen = { url, body };
    return { embeddings: [[0.1, 0.2], [0.3, 0.4]] };
  });
  try {
    const v = await ollama().embed("nomic-embed-text", ["a", "b"]);
    assert.equal(seen!.url, "http://localhost:11434/api/embed");
    assert.equal(seen!.body.model, "nomic-embed-text");
    assert.deepEqual(seen!.body.input, ["a", "b"]);
    assert.deepEqual(v, [[0.1, 0.2], [0.3, 0.4]]);
  } finally {
    restore();
  }
});

test("openai-compat embed posts to /v1/embeddings and maps data[].embedding", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const restore = stubFetch((url, body) => {
    seen = { url, body };
    return { data: [{ embedding: [1, 2, 3] }] };
  });
  try {
    const v = await openai().embed("e5", ["hi"]);
    assert.equal(seen!.url, "http://x/v1/embeddings");
    assert.deepEqual(v, [[1, 2, 3]]);
  } finally {
    restore();
  }
});
