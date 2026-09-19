# OpenAI-compatible remote inference

Local GGUF inference remains the default. Opt in through the existing index YAML
or the SDK's `config` / `configPath`. Remote mode sends document chunks and queries
to the configured service, using `POST <base_url>/embeddings` and
`POST <base_url>/chat/completions`. The base URL includes the API prefix (`/v1`,
or a provider-specific prefix ending in `/v1`). No GGUF model is downloaded or
initialized for these operations.

```yaml
embedding:
  provider: openai
  openai:
    base_url: https://api.openai.com/v1
    model: text-embedding-3-small
    expansion_model: gpt-4o-mini
    rerank_model: gpt-4o-mini       # defaults to expansion_model
    # chat_base_url: https://chat.example.com/v1  # optional separate chat endpoint
    tokenizer: cl100k_base
    context_size: 8192             # set to the endpoint's actual embedding limit
    max_batch_tokens: 8192         # aggregate input budget per request
    timeout_ms: 60000
    # dimensions: 1536            # optional; sent to the embeddings endpoint
```

Set `QMD_OPENAI_API_KEY` in the process environment or a secret manager.
`OPENAI_API_KEY` is a fallback. YAML `api_key` takes precedence, but do not put
credentials in a checked-in config. Expansion and reranking use `chat_base_url`
when present, otherwise `base_url`. `chat_api_key` optionally overrides the
shared API key for chat. `base_url` takes precedence over
`QMD_OPENAI_BASE_URL`, then defaults to `https://api.openai.com/v1`. An API key
alone does not enable remote inference. Unauthenticated servers may omit it.
URLs containing credentials, query parameters, or fragments are rejected.

`model` and `expansion_model` are required. `provider: local` or an absent
`embedding` block uses the existing local `models:` configuration and environment
resolution unchanged. In remote mode the three remote model names take precedence
over local `models:`. Per-call embedding model overrides are rejected; change the
configuration instead. Project-local remote settings require the existing
`qmd trust` approval, including renewed approval when the endpoint changes.

After changing embedding provider, model, tokenizer, context size, or dimensions,
run `qmd embed -f`. These settings contribute to vector identity, so old vectors
are not silently treated as current. Credentials do not contribute to identity;
rotating a key does not require re-embedding. The index supports one embedding
space at a time. `qmd pull` does nothing when remote mode is active.

## Context and batch safety

The existing Markdown/AST breakpoint selection and recursive token-aware splitter
remain in use, with the store's own remote tokenizer. Chunks retain their source
positions. Long titles are bounded separately and included in the input budget;
small context limits also reduce overlap. Both single and batch embedding calls
apply a final guard to the fully formatted input, including direct query calls.
Direct oversized inputs are truncated with a warning, as in local inference;
document indexing splits the body first to preserve coverage.

Choose a tokenizer that matches the embedding endpoint:

- `cl100k_base`: OpenAI text-embedding-3 / text-embedding-ada-002 tokenization.
- `o200k_base`: endpoints explicitly using this encoding.
- `utf8` (default): counts each UTF-8 byte as one budget unit. This is a
  conservative upper bound for byte-fallback tokenizers and avoids loading a
  local model. It creates more, smaller chunks, especially for non-ASCII text.

The default embedding context is 2,048, with reserved overhead. Set it no higher
than the server's configured limit, which can be smaller than a model's training
window. OpenAI compatibility does **not** standardize tokenizers or expose context
limits: arbitrary normalization/tokenization schemes cannot be guaranteed by
`utf8`, and a mismatched BPE encoding can undercount. Confirm the provider's
tokenizer and limit before indexing a corpus. The server remains authoritative.

Each request has at most 32 inputs and is also bounded by `max_batch_tokens`
(default 8,192, at least `context_size`). The complete response is validated for
cardinality, unique integer indexes, full index coverage, nonempty vectors,
consistent dimensions, finite numeric values, and Float32 representability before
vectors are returned. Reordered responses are aligned by index. Dimensions are
checked across requests too, including the first dimension probe.

Invalid batches throw without exposing any of their vectors. The existing store
may retry each input independently; incomplete documents remain pending. There
is no remote circuit breaker or fallback to a different embedding model. Only
HTTP 429 and 5xx are retried (at most two retries), within the request timeout.
Session cancellation and disposal abort in-flight HTTP requests. Error messages
omit response bodies, request content, credentials, and transport error details;
redirects are rejected.

## Chat behavior and limitations

Expansion requests `lex:`, `vec:`, and `hyde:` lines and respects lexical
filtering. Reranking uses an LLM judge via chat completions, not a dedicated
`/rerank` API. It scores up to eight snippets per request on a 0–1 scale and
validates complete index coverage and finite scores. Invalid/truncated chat
responses fail explicitly rather than caching fabricated scores.

- Embeddings and chat may use separate endpoints and keys. Expansion and reranking
  share the chat endpoint. Mixed local-GGUF/remote roles are not supported.
- Reranking truncates the query and each snippet to 512 embedding-tokenizer
  units; its scores are heuristic and may vary between batches. The chat model
  needs sufficient context for eight snippets, instructions, and output.
- Chat endpoints must accept `messages`, `temperature`, and `max_tokens` and
  return textual content in `choices`. Reasoning-only, tool-only, streaming, and
  provider-specific parameter dialects are not implemented.
- Remote embedding inputs use plain text with an optional title; Qwen embedding
  model names retain QMD's query instruction. Other provider-specific prefixes
  are not inferred. Use a model that accepts this input format.
- No automatic model discovery, custom tokenizer download, or adaptive recovery
  from an incorrectly configured context limit is implemented. Rate-limit
  handling is bounded; sustained throttling may require rerunning `qmd embed`.
- A small live smoke test does not establish corpus-scale retrieval quality,
  throughput, or cost. Benchmark representative content before larger indexing.

## Implementation context and verification

[PR #116](https://github.com/tobi/qmd/pull/116) supplied the earlier embedding,
expansion, and chat-judge design. This implementation adapts it to current
per-store instances and sessions. The validation boundary addresses the context
and response-alignment defects reviewed in
[PR #705](https://github.com/tobi/qmd/pull/705).
The local guard from [issue #303](https://github.com/tobi/qmd/issues/303) /
[9718d37](https://github.com/tobi/qmd/commit/9718d37) remains unchanged.

`test/remote-inference.test.ts` uses an in-process HTTP fixture, with no external
credentials or corpus. It exercises YAML/SDK/CLI wiring, local defaults, trust,
oversized transcripts/dense Markdown/code fences/blobs, Unicode, title overhead,
input budgets, malformed batch responses, store recovery, chat routing, retries,
and cancellation. Run the standard `npm test` orchestrator in the development
container to cover Node, Bun, type checking, and package smoke tests; use
`npm run lint` separately. The current project uses `bun.lock` for the frozen
development-container install. The pre-existing pnpm lockfile already differs
from several upstream package versions; this feature only adds its tokenizer
entries rather than refreshing unrelated dependencies.

Validation on Linux arm64 in Docker (2026-09-19): lint, type checking, build,
and the standard test orchestrator passed. Node: 1,287 passed / 79 skipped;
Bun: 1,287 passed / 88 skipped. Package smoke passed under both runtimes.
Final prompt/parser changes were also checked with the 41 focused tests on both
runtimes. Real local GGUF inference is skipped by the CI-mode suite; macOS,
Windows, and Nix were not exercised.

Live synthetic smoke tests passed with separate local Qwen3 embedding/chat
servers, and through OpenRouter with these pairs:

| Embeddings | Expansion and reranking |
| --- | --- |
| `openai/text-embedding-3-small` | `openai/gpt-5.6-luna` |
| `google/gemini-embedding-2` | `deepseek/deepseek-v4.1-flash` |

Each run indexed three synthetic documents into 28 chunks with zero errors,
produced three expansion variants, scored both relevance fixtures correctly,
and returned the cache-policy document first in vector search with reranking.
No real corpus or credentials are included in test fixtures.

To repeat a live check after building, set `QMD_SMOKE_EMBED_BASE_URL`,
`QMD_SMOKE_CHAT_BASE_URL`, `QMD_SMOKE_EMBED_MODEL`, and `QMD_SMOKE_CHAT_MODEL`,
plus the normal API-key environment variable, then run
`node scripts/remote-smoke.mjs`. It creates and removes a temporary synthetic
index. From Docker Desktop/OrbStack, use `host.docker.internal` to reach a
server bound on the host; container `127.0.0.1` refers to the container itself.
