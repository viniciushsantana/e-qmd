# QMD development container

The development container provides Node 22, Bun, SQLite tooling, native build
dependencies, GitHub CLI, Codex, and Claude Code. It supports Linux amd64 and
arm64 images; Docker Desktop on Apple Silicon runs the arm64 image.

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

This creates the following directories with mode `0700` and writes their
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

To use custom host directories, set one or both variables when running the
helper. Values must be absolute paths:

```sh
QMD_DEVCONTAINER_CODEX_STATE="/absolute/path/to/codex" \
QMD_DEVCONTAINER_CLAUDE_STATE="/absolute/path/to/claude" \
  .devcontainer/with-host-agent-state.sh
```

To expose only one agent, run the helper and remove the other agent's line from
`.devcontainer/.env`. Recreate the container after changing modes because mounts
are selected when the container is created. Shell environment variables take
precedence over values saved in the file.

Docker-volume and host-bind state are independent: switching modes does not copy
an existing login. Log in again or deliberately copy only the state you intend
to migrate. Prefer the dedicated directories above instead of binding your main
`~/.codex` or `~/.claude` directory into the container.

To return both agents to Docker-volume mode, remove the persisted overrides and
then rebuild/reopen the container:

```sh
.devcontainer/with-host-agent-state.sh --reset
```

## Ownership and security

The container runs development commands as the non-root `node` user. Its entrypoint
repairs Docker-volume ownership after Dev Containers remaps that user to the host
UID. It deliberately skips ownership changes for opt-in host bind mounts.

The setup does not mount the Docker socket, use privileged mode, mount the host
home directory, or forward authentication tokens by default. Docker volumes are
an isolation convenience, not encryption: anyone with control of the Docker
daemon can inspect them.

## CPU and GPU behavior

The baseline image installs no CUDA or Vulkan runtime. Docker Desktop on macOS
cannot expose Metal to the Linux container, so local inference normally uses the
CPU there. The container does not force `QMD_FORCE_CPU`, leaving a future Linux
GPU configuration possible without changing QMD's defaults.

The three default GGUF models are not prefetched. Once QMD downloads them on an
explicit user command, the `qmd-cache` volume preserves them across rebuilds.

## Verification

The main development checks are:

```sh
node --version
bun --version
sqlite3 --version
codex --version
claude --version
gh --version
bun run lint
bun run test:types
bun run test
QMD_DOCTOR_DEVICE_PROBE=0 bun src/cli/qmd.ts doctor
```

Do not use broad volume-deletion commands to reset the environment: the agent
volumes may contain live credentials. Resolve and inspect the exact Compose
volume names in Docker Desktop or with `docker volume ls` before deleting one.
