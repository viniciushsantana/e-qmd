#!/bin/bash
# Runs once when the development container is created.
set -euo pipefail

for path in \
  /workspace/node_modules \
  /bun-cache \
  /home/node/.cache/qmd \
  /home/node/.config/qmd \
  "${CODEX_HOME:-/codex}" \
  "${CLAUDE_CONFIG_DIR:-/claude}"
do
  if [[ ! -w "${path}" ]]; then
    echo >&2 "Dev container setup: ${path} is not writable by $(id -un)."
    echo >&2 "If it is a host bind, create it as your host user and set mode 0700."
    exit 1
  fi
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-/codex}"
codex_config="${codex_home}/config.toml"

# A Docker volume is empty on first use. Seed only the container-safe defaults;
# never replace a developer's existing config in either volume or bind mode.
if [[ ! -e "${codex_config}" ]]; then
  cp "${script_dir}/codex.config.toml" "${codex_config}"
fi

# bun.lock is QMD's current lockfile. Installation also runs the repository's
# prepare lifecycle, which builds dist/ and installs its pre-push hook.
bun install --frozen-lockfile
