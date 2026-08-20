# Development toolchain only; QMD does not ship or deploy this image.
FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm

ARG BUN_VERSION
ARG NODE_GYP_VERSION
ARG CODEX_VERSION
ARG CLAUDE_CODE_VERSION

# Keep source-build fallbacks available for QMD's native dependencies even when
# a prebuilt binary is unavailable for a particular Node/CPU combination.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      libsqlite3-dev \
      ninja-build \
      pkg-config \
      python3 \
      sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Pin development tools so rebuilding a commit does not silently change them.
RUN npm install --global \
      "bun@${BUN_VERSION}" \
      "node-gyp@${NODE_GYP_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

ENV BUN_INSTALL_CACHE_DIR=/bun-cache

# Empty named volumes inherit these owners on common UID-1000 hosts. The custom
# entrypoint repairs Docker-owned volumes after updateRemoteUserUID on other
# Linux hosts, without touching opt-in host bind mounts.
RUN mkdir -p \
      /workspace/node_modules \
      /bun-cache \
      /home/node/.cache/qmd \
      /home/node/.config/qmd \
      /codex \
      /claude \
    && chown -R node:node \
      /workspace \
      /bun-cache \
      /home/node/.cache \
      /home/node/.config \
      /codex \
      /claude

COPY dev-entrypoint.sh /usr/local/bin/qmd-dev-entrypoint
RUN chmod 0755 /usr/local/bin/qmd-dev-entrypoint

ENTRYPOINT ["/usr/local/bin/qmd-dev-entrypoint"]
