# QMD development container

The development container provides Node 22, Bun, SQLite tooling, native build
dependencies, GitHub CLI, Codex, and Claude Code. It supports Linux amd64 and
arm64.

Codex is installed from the current `@openai/codex` package. Claude Code uses
Anthropic's native installer, which supports background updates. Neither agent
version is pinned; a fresh image build installs the current releases.

## Default setup

Open the repository in a Dev Container-compatible editor and choose **Reopen in
Container**. On first creation, `.devcontainer/post-create.sh` runs `bun install
--frozen-lockfile`. It does not create a QMD collection, download a model, embed
documents, update an index, or modify a QMD database directly.

The project has a `prepare` script that builds `dist/` and installs a pre-push
hook. Because the project root is mounted from the host into the development
container, the hook will also run on the host if you use Git outside the
container. This is expected and harmless, but if you prefer to avoid it, run
Git inside the development container or use `git push --no-verify` when pushing
from the host.

The container forwards port 8181 for the HTTP MCP server. Start it manually when
needed:

```sh
bun src/cli/qmd.ts mcp --http
```

## Persistent storage

By default, all mutable runtime state lives in Docker-managed volumes:

| Container path | Contents |
| --- | --- |
| `/workspace/node_modules` | Linux-native project dependencies |
| `/bun-cache` | Bun's package cache |
| `/home/node/.cache/qmd` | QMD index, caches, and downloaded GGUF models |
| `/home/node/.config/qmd` | QMD collection and model configuration |
| `/codex` | Codex configuration, sessions, and authentication |
| `/claude` | Claude Code configuration, sessions, and authentication |

These volumes survive an ordinary container rebuild. Compose scopes their names
to the development-container project; inspect the resolved names before running
multiple checkouts with the same directory name.

Use device authentication for Codex inside the container:

```sh
codex login --device-auth
```

Codex stores file-based credentials in `/codex/auth.json`. Treat that file and
the corresponding Docker volume like a password. Claude Code can be launched
normally and will keep its state under `/claude`.

## Opt in to host-visible agent state

To keep both agents' state in dedicated host directories, run the helper once:

```sh
.devcontainer/with-host-agent-state.sh
```

This creates the following directories in your host with mode `0700` and writes their
absolute paths to the ignored `.devcontainer/.env` file:

```text
~/.codex-containers/qmd
~/.claude-containers/qmd
```

Then open or rebuild the container normally, using any compatible client:

```sh
code .
# or
devcontainer up --workspace-folder .
```

### Custom host directories for agent state

To use custom host directories, run the helper and then edit
`.devcontainer/.env`. Values must be absolute paths:

```dotenv
QMD_DEVCONTAINER_CODEX_STATE='/absolute/path/to/codex'
QMD_DEVCONTAINER_CLAUDE_STATE='/absolute/path/to/claude'
```

### Disabling host-visible agent state

To return both agents to Docker-volume mode, remove the persisted overrides and
then rebuild/reopen the container:

```sh
.devcontainer/with-host-agent-state.sh --reset
```

## CPU and GPU behavior

The baseline image installs no CUDA or Vulkan runtime. Docker Desktop on macOS
cannot expose Metal to the Linux container, so local inference normally uses the
CPU there. The container does not force `QMD_FORCE_CPU`, leaving a future Linux
GPU configuration possible without changing QMD's defaults.

The three default GGUF models are not prefetched. Once QMD downloads them on an
explicit user command, the `qmd-cache` volume preserves them across rebuilds.
