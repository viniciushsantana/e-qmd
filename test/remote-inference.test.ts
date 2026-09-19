import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import { createInference, remoteModelNames, resolveRemoteConfig, type OpenAIConfig } from "../src/inference.js";
import { validateEmbeddingBatch, OpenAICompatibleLLM } from "../src/openai-llm.js";
import { LlamaCpp, formatDocForEmbedding, formatQueryForEmbedding, setDefaultLlamaCpp, withLLMSessionForLlm } from "../src/llm.js";
import { createStore as createSDKStore } from "../src/index.js";
import { chunkDocumentByTokens, createStore, generateEmbeddings, hashContent, syncConfigToDb } from "../src/store.js";
import { loadConfig, saveConfig, setConfigSource } from "../src/collections.js";
import { gatedItems, hasGatedItems, sensitiveDigest } from "../src/trust.js";

const requestSchema = z.object({
  model: z.string(), input: z.array(z.string()).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
  temperature: z.number().optional(),
});
type RequestBody = z.infer<typeof requestSchema>;
let server: Server;
let baseURL: string;
let requests: { path: string; authorization?: string; body: RequestBody }[];
let respond: (body: RequestBody) => unknown;
let status: number;
let delay: number;
let temp: string;
const instances: LlamaCpp[] = [];

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), "qmd-remote-test-"));
  requests = [];
  status = 200;
  delay = 0;
  respond = body => ({ data: body.input!.map((_, index) => ({ index, embedding: [index + 1, 2, 3] })).reverse() });
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = requestSchema.parse(JSON.parse(raw));
    requests.push({ path: req.url!, authorization: req.headers.authorization, body });
    const payload = respond(body);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  for (const llm of instances.splice(0)) await llm.dispose();
  setDefaultLlamaCpp(null);
  setConfigSource(undefined);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(temp, { recursive: true, force: true });
});

function remote(overrides: Partial<OpenAIConfig> = {}): LlamaCpp {
  const llm = createInference({ collections: {}, embedding: { provider: "openai", openai: {
    model: "embedding-fixture", expansion_model: "expansion-fixture", rerank_model: "judge-fixture",
    base_url: baseURL, api_key: "fixture-key-not-a-credential", ...overrides,
  } } });
  instances.push(llm);
  return llm;
}

describe("remote inference configuration", () => {
  test("local inference and formatting remain defaults, even with an API key in the environment", async () => {
    const old = process.env.QMD_OPENAI_API_KEY;
    process.env.QMD_OPENAI_API_KEY = "fixture-env-key";
    try {
      const llm = createInference({ collections: {}, models: { embed: "local.gguf" } });
      instances.push(llm);
      expect(llm.constructor).toBe(LlamaCpp);
      expect(llm.embedModelName).toBe("local.gguf");
      expect(await llm.embeddingChunkSize()).toBe(Infinity);
      expect(formatQueryForEmbedding("hello", "local.gguf")).toBe("task: search result | query: hello");
      expect(formatDocForEmbedding("body", "title", "local.gguf")).toBe("title: title | text: body");
      expect(formatDocForEmbedding("body", "title", "qwen3-embedding")).toBe("title\nbody");
      expect(resolveRemoteConfig({ provider: "local" })).toBeUndefined();
      expect(requests).toHaveLength(0);
    } finally {
      if (old === undefined) delete process.env.QMD_OPENAI_API_KEY;
      else process.env.QMD_OPENAI_API_KEY = old;
    }
  });

  test("YAML round trip wires all remote fields and respects config over environment", async () => {
    const old = process.env.QMD_OPENAI_API_KEY;
    process.env.QMD_OPENAI_API_KEY = "fixture-env-key";
    try {
      setConfigSource({ configPath: join(temp, "index.yml") });
      saveConfig({ collections: {}, embedding: { provider: "openai", openai: {
        base_url: `${baseURL}/`, api_key: "fixture-config-key", model: "embedding-fixture",
        expansion_model: "expansion-fixture", rerank_model: "judge-fixture", context_size: 256,
        tokenizer: "cl100k_base", dimensions: 3, max_batch_tokens: 1024,
      } } });
      const config = loadConfig();
      const resolved = resolveRemoteConfig(config.embedding)!;
      expect(resolved.api_key).toBe("fixture-config-key");
      expect(resolved.base_url).toBe(baseURL);
      const llm = createInference(config);
      instances.push(llm);
      expect(llm).toBeInstanceOf(OpenAICompatibleLLM);
      await llm.embed("body");
      expect(requests[0]!.authorization).toBe("Bearer fixture-config-key");
      expect(requests[0]!.body.model).toBe("embedding-fixture");
      const { api_key, ...withoutKey } = config.embedding!.openai!;
      expect(resolveRemoteConfig({ provider: "openai", openai: withoutKey })!.api_key).toBe("fixture-env-key");
    } finally {
      if (old === undefined) delete process.env.QMD_OPENAI_API_KEY;
      else process.env.QMD_OPENAI_API_KEY = old;
    }
  });

  test.each([
    { context_size: 0 }, { context_size: 1.5 }, { context_size: 10000, max_batch_tokens: 100 },
    { base_url: "https://user:private@example.com/v1" }, { base_url: "https://example.com/v1?key=private" },
    { model: "" }, { expansion_model: "" }, { dimensions: -1 },
  ])("rejects invalid config without echoing values: %j", bad => {
    expect(() => remote(bad)).toThrow();
    try { remote(bad); } catch (error) { expect(String(error)).not.toContain("private"); }
  });

  test("identity changes with endpoint, context, tokenizer, dimensions or model, but not credentials", () => {
    const config = resolveRemoteConfig({ provider: "openai", openai: { model: "embed", expansion_model: "chat", base_url: baseURL } })!;
    const names = remoteModelNames(config);
    expect(remoteModelNames({ ...config, api_key: "another-fixture-key" })).toEqual(names);
    for (const changed of [{ base_url: `${baseURL}/other` }, { context_size: 1024 }, { tokenizer: "cl100k_base" as const }, { dimensions: 3 }, { model: "other" }]) {
      expect(remoteModelNames({ ...config, ...changed }).embed).not.toBe(names.embed);
    }
    const otherChat = remoteModelNames({ ...config, chat_base_url: `${baseURL}/chat` });
    expect(otherChat.embed).toBe(names.embed);
    expect(otherChat.generate).not.toBe(names.generate);
    expect(otherChat.rerank).not.toBe(names.rerank);
  });

  test("remote settings participate in the existing local-config trust gate", () => {
    const builtins = { embed: "embed", generate: "generate", rerank: "rerank" };
    const snapshot = { hooks: [], paths: [], models: {}, remote: { provider: "openai" as const, openai: { model: "embed", expansion_model: "chat", base_url: baseURL } } };
    const configPath = join(temp, ".qmd", "index.yml");
    expect(hasGatedItems(gatedItems(configPath, snapshot, builtins))).toBe(true);
    const first = sensitiveDigest(snapshot, configPath, builtins);
    snapshot.remote.openai.base_url += "/changed";
    expect(sensitiveDigest(snapshot, configPath, builtins)).not.toBe(first);
  });

  test("trust covers remote destinations and models, excluding credentials and tuning", () => {
    const builtins = { embed: "embed", generate: "generate", rerank: "rerank" };
    const config: OpenAIConfig = { model: "embed", expansion_model: "chat", base_url: baseURL };
    const digest = (overrides: Partial<OpenAIConfig> = {}) => sensitiveDigest({
      hooks: [], paths: [], models: {}, remote: { provider: "openai", openai: { ...config, ...overrides } },
    }, join(temp, ".qmd", "index.yml"), builtins);
    const initial = digest();
    for (const override of [
      { api_key: "rotated-fixture" }, { chat_api_key: "rotated-chat-fixture" },
      { timeout_ms: 1234 }, { max_batch_tokens: 4096 }, { context_size: 1024 },
      { tokenizer: "cl100k_base" as const }, { dimensions: 3 },
      { chat_base_url: baseURL }, { rerank_model: "chat" },
    ]) expect(digest(override)).toBe(initial);
    for (const override of [
      { base_url: `${baseURL}/other` }, { chat_base_url: `${baseURL}/other` },
      { model: "other" }, { expansion_model: "other" }, { rerank_model: "other" },
    ]) expect(digest(override)).not.toBe(initial);
  });

  test("trust re-arms for an environment-resolved endpoint change", () => {
    const previous = process.env.QMD_OPENAI_BASE_URL;
    const snapshot = { hooks: [], paths: [], models: {}, remote: { provider: "openai" as const, openai: { model: "embed", expansion_model: "chat" } } };
    const digest = () => sensitiveDigest(snapshot, join(temp, ".qmd", "index.yml"), { embed: "embed", generate: "generate", rerank: "rerank" });
    try {
      process.env.QMD_OPENAI_BASE_URL = baseURL;
      const first = digest();
      process.env.QMD_OPENAI_BASE_URL = `${baseURL}/other`;
      expect(digest()).not.toBe(first);
    } finally {
      if (previous === undefined) delete process.env.QMD_OPENAI_BASE_URL;
      else process.env.QMD_OPENAI_BASE_URL = previous;
    }
  });
});

describe("embedding response integrity", () => {
  test("maps valid shuffled vectors to their input indexes", async () => {
    const results = await remote().embedBatch(["first", "second", "third"]);
    expect(results.map(r => r!.embedding[0])).toEqual([1, 2, 3]);
    expect(requests[0]!.path).toBe("/v1/embeddings");
  });

  test.each([
    [], [{ index: 0, embedding: [1, 2] }, { index: 2, embedding: [3, 4] }],
    [0, 0, 2].map(index => ({ index, embedding: [1, 2] })),
    [0, 1, 3].map(index => ({ index, embedding: [1, 2] })),
    [-1, 1, 2].map(index => ({ index, embedding: [1, 2] })),
    [0, 1.5, 2].map(index => ({ index, embedding: [1, 2] })),
    ["0", 1, 2].map(index => ({ index, embedding: [1, 2] })),
    [0, 1, 2].map(index => ({ index, embedding: index === 2 ? [1] : [1, 2] })),
    [0, 1, 2].map(index => ({ index, embedding: [] })),
    [0, 1, 2].map(index => ({ index, embedding: [null, 2] })),
    [0, 1, 2].map(index => ({ index, embedding: ["1", 2] })),
    [0, 1, 2, 3].map(index => ({ index, embedding: [1, 2] })),
  ].map(data => [data]))("rejects malformed/partial batch before returning vectors (%#)", async data => {
    respond = () => ({ data });
    await expect(remote().embedBatch(["first", "second", "third"])).rejects.toThrow("Invalid embedding");
  });

  test("rejects non-finite values, Float32 overflow and changing dimensions", async () => {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      expect(() => validateEmbeddingBatch({ data: [{ index: 0, embedding: [value] }] }, 1)).toThrow();
    }
    const llm = remote();
    await llm.embed("first");
    respond = () => ({ data: [{ index: 0, embedding: [1, 2] }] });
    await expect(llm.embed("second")).rejects.toThrow("dimensions");
  });

  test("concurrent first batches cannot establish different embedding dimensions", async () => {
    const llm = remote();
    delay = 25;
    respond = body => ({ data: [{ index: 0, embedding: body.input![0] === "first" ? [1, 2] : [1, 2, 3] }] });
    const results = await Promise.allSettled([llm.embedBatch(["first"]), llm.embedBatch(["second"])]);
    expect(requests).toHaveLength(2);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected");
    expect(failed?.status === "rejected" ? String(failed.reason) : "").toContain("dimensions");
  });

  test("a rejected request does not poison subsequent batches or leak the provider's error body", async () => {
    const llm = remote();
    status = 400;
    respond = () => ({ error: "private document fixture-key-not-a-credential" });
    await expect(llm.embed("first")).rejects.toThrow("Remote inference HTTP 400");
    expect(requests).toHaveLength(1);
    status = 200;
    respond = () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    expect((await llm.embed("second"))!.embedding).toEqual([1, 2, 3]);
  });
});

describe("context protection and recursive Markdown splitting", () => {
  const fixtures = [
    ["transcript", "Speaker: Discussão de decisões e próximos passos 中文.\n".repeat(600)],
    ["dense-markdown", "| 中文🙂 | **dense** | `x=>{a:1}` |\n".repeat(600)],
    ["code-fence", "```typescript\n" + "const token={a:'中文🙂',b:0xfeed};\n".repeat(800) + "```"],
    ["single-line", "ab01中文🙂!@#$%^&*()".repeat(1200)],
  ];

  test.each(fixtures)("preserves all content and positions for oversized %s", async (_name, body) => {
    const llm = remote({ context_size: 256, tokenizer: "cl100k_base" });
    setDefaultLlamaCpp(llm);
    const chunks = await chunkDocumentByTokens(body!, undefined, undefined, undefined, "fixture.md");
    expect(chunks.length).toBeGreaterThan(1);
    const encoding = getEncoding("cl100k_base");
    let covered = 0;
    for (const chunk of chunks) {
      expect(chunk.text).toBe(body!.slice(chunk.pos, chunk.pos + chunk.text.length));
      expect(chunk.pos).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, chunk.pos + chunk.text.length);
      expect(encoding.encode(chunk.text, [], []).length).toBeLessThanOrEqual(224);
      expect(chunk.text).not.toContain("\uFFFD");
    }
    expect(covered).toBe(body!.length);
  });

  test("single and batch calls guard actual formatted input, Unicode and aggregate request budget", async () => {
    const llm = remote({ context_size: 128, max_batch_tokens: 256, tokenizer: "cl100k_base" });
    const text = "中文🙂dense`code`<|endoftext|>".repeat(100);
    await llm.embed(text);
    const result = await llm.embedBatch(Array(5).fill(text));
    expect(result).toHaveLength(5);
    const encoding = getEncoding("cl100k_base");
    for (const request of requests) {
      const counts = request.body.input!.map(input => encoding.encode(input, [], []).length);
      expect(counts.every(count => count <= 112)).toBe(true);
      expect(counts.reduce((a, b) => a + b + 16, 0)).toBeLessThanOrEqual(256);
    }
    expect(requests.length).toBeGreaterThan(2);
  });

  test("store embedding includes title overhead, stores all chunks and recovers safely from a partial batch", async () => {
    const llm = remote({ context_size: 128, max_batch_tokens: 512, tokenizer: "utf8" });
    const store = createStore(join(temp, "index.sqlite"));
    store.llm = llm;
    try {
      syncConfigToDb(store.db, { collections: { fixtures: { path: temp, pattern: "*.md" } } });
      const body = `# ${"long-title中文".repeat(90)}\n\n` + "Speaker: 中文🙂 dense content and code.\n".repeat(100);
      const hash = await hashContent(body);
      const now = new Date().toISOString();
      store.insertContent(hash, body, now);
      store.insertDocument("fixtures", "fixture.md", "fixture", hash, now, now);
      let malformed = false;
      respond = request => {
        const inputs = request.input!;
        if (inputs.length > 1 && !malformed) {
          malformed = true;
          return { data: [{ index: inputs.length - 1, embedding: [99, 99, 99] }] };
        }
        return { data: inputs.map((_, index) => ({ index, embedding: [1, 2, 3] })).reverse() };
      };
      const result = await generateEmbeddings(store);
      expect(malformed).toBe(true);
      expect(result.errors).toBe(0);
      expect(result.chunksEmbedded).toBeGreaterThan(32);
      expect(store.getHashesNeedingEmbedding()).toBe(0);
      for (const request of requests) for (const input of request.body.input!) {
        expect(Buffer.byteLength(input)).toBeLessThanOrEqual(112);
      }
      const rows = store.db.prepare("SELECT COUNT(*) AS count FROM content_vectors").get() as { count: number };
      expect(rows.count).toBe(result.chunksEmbedded);
      const vectors = store.db.prepare("SELECT vec_to_json(embedding) AS vector FROM vectors_vec").all() as { vector: string }[];
      expect(vectors.every(row => JSON.parse(row.vector).every((v: number, i: number) => v === i + 1))).toBe(true);
    } finally { store.close(); }
  });
});

describe("chat routing and session lifecycle", () => {
  test("generate honors temperature, while expansion and reranking remain deterministic", async () => {
    const llm = remote();
    respond = () => ({ choices: [{ message: { content: "vec: semantic query" }, finish_reason: "stop" }] });
    await llm.generate("prompt", { temperature: 0.25 });
    await llm.generate("prompt", { temperature: 0 });
    await llm.generate("prompt");
    await llm.expandQuery("query");
    respond = () => ({ choices: [{ message: { content: '[{"index":0,"score":0.9}]' }, finish_reason: "stop" }] });
    await llm.rerank("query", [{ file: "a", text: "body" }]);
    expect(requests.map(request => request.body.temperature)).toEqual([0.25, 0, 0.7, 0, 0]);
  });

  test("deduplicates expansion retrieval routes without dropping distinct variants", async () => {
    respond = () => ({ choices: [{ message: { content: [
      "lex: shared query", "lex: shared   query", "vec: shared query", "vec: shared query",
      "hyde: shared   query", "vec: distinct variant", "hyde: hypothetical answer",
    ].join("\n") }, finish_reason: "stop" }] });
    expect(await remote().expandQuery("query")).toEqual([
      { type: "lex", text: "shared query" }, { type: "vec", text: "shared query" },
      { type: "vec", text: "distinct variant" }, { type: "hyde", text: "hypothetical answer" },
    ]);
  });

  test("separate chat URL and key leave embeddings on their own endpoint", async () => {
    const llm = remote({ chat_base_url: `${baseURL}/chat`, chat_api_key: "fixture-chat-key" });
    respond = body => body.input
      ? { data: [{ index: 0, embedding: [1, 2, 3] }] }
      : { choices: [{ message: { content: "vec: semantic query" }, finish_reason: "stop" }] };
    await llm.embed("body");
    await llm.expandQuery("query");
    expect(requests.map(r => r.path)).toEqual(["/v1/embeddings", "/v1/chat/chat/completions"]);
    expect(requests.map(r => r.authorization)).toEqual(["Bearer fixture-key-not-a-credential", "Bearer fixture-chat-key"]);
  });

  test("uses configured chat models, lexical filtering, and validates shuffled judge scores", async () => {
    const llm = remote();
    respond = body => ({ choices: [{ finish_reason: "stop", message: { content: body.model === "expansion-fixture"
      ? "lex: key terms\nvec: semantic query\nhyde: hypothetical answer"
      : '{"results":[{"index":1,"score":0.9},{"index":0,"score":0.2}]}' } }] });
    expect(await llm.expandQuery("query", { includeLexical: false })).toEqual([
      { type: "vec", text: "semantic query" }, { type: "hyde", text: "hypothetical answer" },
    ]);
    const reranked = await llm.rerank("query", [{ file: "a", text: "first" }, { file: "b", text: "second" }]);
    expect(reranked.results).toEqual([{ file: "b", index: 1, score: 0.9 }, { file: "a", index: 0, score: 0.2 }]);
    expect(requests.map(r => r.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    expect(requests.map(r => r.body.model)).toEqual(["expansion-fixture", "judge-fixture"]);
    expect(await llm.rerank("query", [])).toEqual({ results: [], model: llm.rerankModelName });
    respond = () => ({ choices: [{ message: { content: '```json\n[{"index":0,"score":0.8}]\n```' } }] });
    expect((await llm.rerank("query", [{ file: "a", text: "body" }])).results).toEqual([{ file: "a", index: 0, score: 0.8 }]);
  });

  test("rejects incomplete, duplicate and non-finite/out-of-range judge results", async () => {
    const llm = remote();
    for (const content of ['{"results":[]}', '{"results":[{"index":0,"score":2}]}', '{"results":[{"index":2,"score":0.2}]}']) {
      respond = () => ({ choices: [{ message: { content } }] });
      await expect(llm.rerank("query", [{ file: "a", text: "body" }])).rejects.toThrow();
    }
    respond = () => ({ choices: [{ message: { content: '[{"index":0,"score":0.9},{"index":0,"score":0.2}]' } }] });
    await expect(llm.rerank("query", [{ file: "a", text: "body" }, { file: "b", text: "other" }])).rejects.toThrow("indexes");
  });

  test("session abort cancels remote requests and never initializes a local model", async () => {
    const llm = remote();
    const controller = new AbortController();
    await withLLMSessionForLlm(llm, async session => {
      await session.embed("first");
      controller.abort();
      await expect(session.embed("second")).rejects.toThrow();
    }, { signal: controller.signal });
    expect(requests).toHaveLength(1);
  });

  test("in-flight requests obey the session deadline and request timeout", async () => {
    delay = 200;
    await expect(withLLMSessionForLlm(remote(), session => session.embed("first"), { maxDuration: 20 })).rejects.toThrow("aborted");
    await expect(remote({ timeout_ms: 20 }).embed("second")).rejects.toThrow("timed out");
  });

  test("transient errors have bounded retries", async () => {
    respond = () => {
      status = requests.length < 3 ? 503 : 200;
      return { data: [{ index: 0, embedding: [1, 2, 3] }] };
    };
    expect((await remote().embed("first"))!.embedding).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(3);
  });

  test("SDK config selects remote embeddings through the real store", async () => {
    const store = await createSDKStore({ dbPath: join(temp, "sdk.sqlite"), config: {
      collections: {}, embedding: { provider: "openai", openai: { base_url: baseURL, model: "sdk-embedding", expansion_model: "sdk-chat" } },
    } });
    try {
      expect(store.internal.llm).toBeInstanceOf(OpenAICompatibleLLM);
      await store.internal.llm!.embed("hello");
      expect(requests[0]!.body.model).toBe("sdk-embedding");
    } finally { await store.close(); }
  });
});

test("CLI consumes remote YAML, embeds, and does not pull GGUF models", async () => {
  const docs = join(temp, "docs");
  const configDir = join(temp, "config");
  mkdirSync(docs); mkdirSync(configDir);
  writeFileSync(join(docs, "fixture.md"), "# Fixture\n\nRemote inference integration fixture.");
  writeFileSync(join(configDir, "index.yml"), `collections:\n  fixtures:\n    path: ${docs}\n    pattern: '*.md'\nembedding:\n  provider: openai\n  openai:\n    base_url: ${baseURL}\n    model: cli-embedding\n    expansion_model: cli-chat\n`);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script = join(root, "src/cli/qmd.ts");
  const isBun = "Bun" in globalThis;
  async function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [...(isBun ? [] : [join(root, "node_modules/tsx/dist/cli.mjs")]), script, ...args], {
        cwd: temp, env: { ...process.env, QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: join(temp, "cache"), INDEX_PATH: join(temp, "cli.sqlite"), PWD: temp },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      proc.stdout.on("data", chunk => output += chunk);
      proc.stderr.on("data", chunk => output += chunk);
      proc.on("error", reject);
      proc.on("close", code => code === 0 ? resolve(output) : reject(new Error(output)));
    });
  }
  await run(["update"]);
  await run(["embed"]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(r => r.body.model === "cli-embedding")).toBe(true);
  expect(await run(["pull"])).toContain("no GGUF models");
  expect(await run(["embed"])).toContain("already have embeddings");
  respond = body => body.input
    ? { data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }
    : { choices: [{ message: { content: body.messages![0]!.content.includes("lex:")
      ? "vec: semantic retrieval fixture\nhyde: hypothetical fixture answer"
      : '{"results":[{"index":0,"score":0.9}]}' }, finish_reason: "stop" }] };
  await run(["query", "unseen query"]);
  expect(requests.some(r => r.path === "/v1/chat/completions" && r.body.model === "cli-chat")).toBe(true);
  expect(await run(["doctor"])).toContain("OpenAI-compatible remote inference configured");
}, 60000);
