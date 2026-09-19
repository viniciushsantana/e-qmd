# Common inference configurations

Choose one configuration below and merge it into your existing `index.yml`,
preserving `collections:` and other settings. The global config is normally
`~/.config/qmd/index.yml`; a project-local index uses `.qmd/index.yml`.
See [configuration locations](../README.md#configuring-indexyml) and the
[remote inference reference](remote-inference.md) for all options.

Real API keys belong in the process environment or a secret manager, never a
checked-in YAML file. YAML values such as `${OPENAI_API_KEY}` are **not** expanded
by QMD. Set environment variables in the same shell, container, or service that
runs QMD; the host shell's variables are not automatically available in Docker.

## Local GGUF models (default)

No API server or API key is needed. Omitting `embedding:` uses local inference;
set `provider: local` explicitly when switching back from remote inference.
The optional `models:` block below selects the current built-in defaults.

```yaml
embedding:
  provider: local
models:
  embed: hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf
  generate: hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf
  rerank: hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf
```

`qmd pull` downloads the selected GGUF models. Existing local model overrides
and environment resolution still work; remove the optional `models:` block to
use your environment overrides. Inference runs inside QMD after model download.

## Local OpenAI-compatible servers

This uses HTTP to reach models you already serve locally; it does not load GGUF
models inside QMD. Start an embedding server on port 8080 and a chat server on
port 8081, or replace the URLs with your actual endpoints. This example uses
Qwen3-Embedding-8B for embeddings and Qwen3-0.6B at Q8 quantization for expansion
and reranking. Adjust the model IDs below to match those exposed by your servers.

```yaml
embedding:
  provider: openai
  openai:
    base_url: http://127.0.0.1:8080/v1
    chat_base_url: http://127.0.0.1:8081/v1
    model: qwen3-embedding-8b
    expansion_model: qwen3-0.6b-q8
    rerank_model: qwen3-0.6b-q8
    tokenizer: utf8
    context_size: 2048
    max_batch_tokens: 8192
    timeout_ms: 60000
```

For a server that accepts any nonempty key:

```sh
export QMD_OPENAI_API_KEY="local-development-dummy"
```

For unauthenticated servers, instead unset both `QMD_OPENAI_API_KEY` and
`OPENAI_API_KEY` so an unrelated cloud key is not sent to your local server.
If your server requires authentication, load its real key from a secret manager.
When QMD runs in Docker Desktop/OrbStack and the servers run on the host, replace
both occurrences of `127.0.0.1` with `host.docker.internal`.

`utf8` uses conservative byte budgeting, not the model's native tokenizer. Keep
`context_size` at or below the server's configured limit and confirm tokenizer
compatibility before large indexing jobs. Expansion and reranking share the chat
endpoint; mixing in-process GGUF roles with HTTP roles is not supported.

## OpenRouter

Load your OpenRouter key into `OPENROUTER_API_KEY` with your secret manager,
then map it to the environment variable QMD reads:

```sh
export QMD_OPENAI_API_KEY="${OPENROUTER_API_KEY:?Load your OpenRouter key first}"
```

```yaml
embedding:
  provider: openai
  openai:
    base_url: https://openrouter.ai/api/v1
    model: openai/text-embedding-3-small
    expansion_model: openai/gpt-5.6-luna
    rerank_model: openai/gpt-5.6-luna
    tokenizer: cl100k_base
    context_size: 8192
    max_batch_tokens: 8192
    timeout_ms: 60000
```

The provider-qualified model names are intentional. Other chat models exercised
by the synthetic smoke tests are `deepseek/deepseek-v4.1-flash` and
`z-ai/glm-5.3-flash`; replace both chat model fields to use one of them.
`rerank_model` may also be omitted to reuse `expansion_model`.

For the tested Gemini embedding alternative, use this complete replacement:

```yaml
embedding:
  provider: openai
  openai:
    base_url: https://openrouter.ai/api/v1
    model: google/gemini-embedding-2
    expansion_model: z-ai/glm-5.3-flash
    rerank_model: z-ai/glm-5.3-flash
    tokenizer: utf8
    context_size: 2048
    max_batch_tokens: 8192
    timeout_ms: 60000
```

The Gemini example deliberately uses conservative byte budgeting; do not carry
over `cl100k_base` from the OpenAI embedding example. Model availability depends
on the provider/account. Cloud inference sends document chunks and query text
to the configured service and can incur charges.

## OpenAI API directly

Load an OpenAI API key into `OPENAI_API_KEY` with your secret manager. If you
previously used OpenRouter or a local dummy key, clear the higher-priority QMD
override first:

```sh
unset QMD_OPENAI_API_KEY
: "${OPENAI_API_KEY:?Load your OpenAI API key first}"
```

```yaml
embedding:
  provider: openai
  openai:
    base_url: https://api.openai.com/v1
    model: text-embedding-3-small
    expansion_model: gpt-4o-mini
    rerank_model: gpt-4o-mini
    tokenizer: cl100k_base
    context_size: 8192
    max_batch_tokens: 8192
    timeout_ms: 60000
```

Unlike OpenRouter, direct OpenAI model names have no `openai/` prefix. This
example follows the official [embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
and [GPT-4o mini documentation](https://developers.openai.com/api/docs/models/gpt-4o-mini).
QMD uses Chat Completions with `temperature` and `max_tokens`, so do not assume
that every newer/reasoning model is a drop-in replacement. This direct-API
example is schema-validated and documentation-checked, not live-tested with an
OpenAI account; the live OpenAI-family tests used OpenRouter.

## After choosing or changing a configuration

- Keep existing collections, or register a directory with
  `qmd collection add ~/notes --name notes --mask '**/*.md'`.
- For project-local remote config, review the endpoints and run `qmd trust`.
  Endpoint/model changes require renewed approval; key rotation does not.
- Run `qmd update`, then `qmd embed`. When changing embedding provider, endpoint,
  model, tokenizer, context size, or dimensions on an existing index, use
  `qmd embed -f` to rebuild its vectors. This can incur provider charges.
- Check `qmd query "your question"`. `qmd search "exact terms"` remains lexical.
- Remote `qmd pull` is a no-op when trusted; it does not download local GGUF
  models if you decline remote trust.
- In CI only, intentional remote calls require `QMD_ALLOW_REMOTE_IN_CI=1`.
  Do not set this globally merely to run unrelated tests.

See [context and batch safety](remote-inference.md#context-and-batch-safety)
before increasing limits. Successful small smoke tests are not a throughput,
cost, or retrieval-quality benchmark for your own corpus.
