import { createHash } from "node:crypto";
import { z } from "zod";
import { LlamaCpp, type LlamaCppConfig } from "./llm.js";
import { OpenAICompatibleLLM } from "./openai-llm.js";
import type { CollectionConfig } from "./collections.js";

const remoteSchema = z.object({
  base_url: z.string().url().default("https://api.openai.com/v1"),
  api_key: z.string().optional(),
  chat_base_url: z.string().url().optional(),
  chat_api_key: z.string().optional(),
  model: z.string().trim().min(1),
  expansion_model: z.string().trim().min(1),
  rerank_model: z.string().trim().min(1).optional(),
  context_size: z.number().int().min(64).max(1048576).default(2048),
  tokenizer: z.enum(["cl100k_base", "o200k_base", "utf8"]).default("utf8"),
  dimensions: z.number().int().positive().optional(),
  max_batch_tokens: z.number().int().positive().default(8192),
  timeout_ms: z.number().int().min(1).max(600000).default(60000),
}).strict();

export type OpenAIConfig = z.input<typeof remoteSchema>;
export type ResolvedOpenAIConfig = z.output<typeof remoteSchema>;
export type InferenceConfig = { provider: "local" | "openai"; openai?: OpenAIConfig };

export function resolveRemoteConfig(config?: InferenceConfig): ResolvedOpenAIConfig | undefined {
  if (!config || config.provider === "local") return undefined;
  if (config.provider !== "openai") throw new Error("embedding.provider must be local or openai");
  const parsed = remoteSchema.safeParse({
    ...config.openai,
    base_url: config.openai?.base_url ?? process.env.QMD_OPENAI_BASE_URL,
    api_key: config.openai?.api_key ?? process.env.QMD_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  });
  // Never include config values or provider responses in errors: either may contain secrets.
  if (!parsed.success) throw new Error(`Invalid remote inference config: ${parsed.error.issues.map(i => i.path.join(".")).join(", ")}`);
  const value = parsed.data;
  for (const key of ["base_url", "chat_base_url"] as const) {
    const address = value[key];
    if (!address) continue;
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Remote base URLs must be HTTP(S) URLs without credentials, query, or fragment");
    }
    value[key] = url.toString().replace(/\/+$/, "");
  }
  if (value.max_batch_tokens < value.context_size) throw new Error("max_batch_tokens must be at least context_size");
  return value;
}

/** Endpoint and token budget are part of vector/cache identity; credentials never are. */
export function remoteModelNames(config: ResolvedOpenAIConfig): { embed: string; generate: string; rerank: string } {
  const digest = createHash("sha256").update(JSON.stringify([
    config.base_url, config.context_size, config.tokenizer, config.dimensions ?? null, "remote-v1",
  ])).digest("hex").slice(0, 16);
  const chatDigest = createHash("sha256").update(JSON.stringify([
    config.chat_base_url ?? config.base_url, config.tokenizer, "remote-chat-v2",
  ])).digest("hex").slice(0, 16);
  return {
    embed: `openai:${config.model}:${digest}`,
    generate: `openai:${config.expansion_model}:${chatDigest}`,
    rerank: `openai:${config.rerank_model ?? config.expansion_model}:${chatDigest}`,
  };
}

export function createInference(config?: CollectionConfig, local: LlamaCppConfig = {}): LlamaCpp {
  const remote = resolveRemoteConfig(config?.embedding);
  return remote ? new OpenAICompatibleLLM(remote, remoteModelNames(remote)) : new LlamaCpp({
    ...local,
    embedModel: config?.models?.embed ?? local.embedModel,
    generateModel: config?.models?.generate ?? local.generateModel,
    rerankModel: config?.models?.rerank ?? local.rerankModel,
  });
}
