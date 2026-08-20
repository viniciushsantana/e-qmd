#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo >&2 "Usage: $0 <dev-container client command> [args...]"
  echo >&2 "Example: $0 code ."
  exit 2
fi

codex_state="${QMD_DEVCONTAINER_CODEX_STATE:-${HOME}/.codex-containers/qmd}"
claude_state="${QMD_DEVCONTAINER_CLAUDE_STATE:-${HOME}/.claude-containers/qmd}"

for path in "${codex_state}" "${claude_state}"; do
  case "${path}" in
    /*) ;;
    *)
      echo >&2 "Agent state paths must be absolute: ${path}"
      exit 2
      ;;
  esac

  mkdir -p "${path}"
  chmod 0700 "${path}"
done

export QMD_DEVCONTAINER_CODEX_STATE="${codex_state}"
export QMD_DEVCONTAINER_CLAUDE_STATE="${claude_state}"

exec "$@"
