// Opt-in live check. Uses only synthetic documents in a disposable temporary index.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../dist/index.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run the live remote smoke test`);
  return value;
}

const openai = {
  base_url: required("QMD_SMOKE_EMBED_BASE_URL"),
  chat_base_url: required("QMD_SMOKE_CHAT_BASE_URL"),
  model: required("QMD_SMOKE_EMBED_MODEL"),
  expansion_model: required("QMD_SMOKE_CHAT_MODEL"),
  // Keys are resolved by QMD from QMD_OPENAI_API_KEY / OPENAI_API_KEY.
  context_size: 512,
  max_batch_tokens: 2048,
  tokenizer: "utf8",
};
const dir = await mkdtemp(join(tmpdir(), "qmd-remote-smoke-"));
let store;
try {
  const docs = join(dir, "docs");
  await mkdir(docs);
  await writeFile(join(docs, "cache.md"), "# Cache policy\n\nTemporary cache entries expire after sixty seconds. This avoids serving stale results.\n");
  await writeFile(join(docs, "garden.md"), "# Garden\n\nWater the tomato plants every morning. Keep the soil moist.\n");
  await writeFile(join(docs, "transcript.md"), "# Synthetic transcript\n\n" + "Speaker: decisões de projeto 中文🙂.\n```js\nconst value={a:1,b:'texto'};\n```\n".repeat(60));
  store = await createStore({ dbPath: join(dir, "index.sqlite"), config: {
    collections: { synthetic: { path: docs, pattern: "*.md" } },
    embedding: { provider: "openai", openai },
  } });
  await store.update();
  const embedded = await store.embed();
  assert.equal(embedded.errors, 0);
  assert.ok(embedded.chunksEmbedded > 3);
  assert.equal(store.internal.getHashesNeedingEmbedding(), 0);
  console.log(JSON.stringify({ stage: "embeddings", documents: embedded.docsProcessed, chunks: embedded.chunksEmbedded, errors: embedded.errors }));

  const query = "When do temporary cache entries expire?";
  const expansions = await store.internal.llm.expandQuery(query);
  assert.ok(expansions.length > 0);
  console.log(JSON.stringify({ stage: "expansion", variants: expansions.length }));
  const ranked = await store.internal.llm.rerank(query, [
    { file: "cache.md", text: "Temporary cache entries expire after sixty seconds." },
    { file: "garden.md", text: "Water tomato plants every morning." },
  ]);
  assert.equal(ranked.results.length, 2);
  console.log(JSON.stringify({ stage: "rerank", results: ranked.results }));
  const results = await store.search({ queries: [{ type: "vec", query }], limit: 3, minScore: 0 });
  assert.ok(results.length > 0);
  console.log(JSON.stringify({ stage: "search", matches: results.length, first: results[0].file }));
} finally {
  await store?.close();
  await rm(dir, { recursive: true, force: true });
}
