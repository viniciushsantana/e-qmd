#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 [--reset]"
  echo
  echo "Without arguments, persist host-mounted Codex and Claude state."
  echo "Use --reset to return both agents to Docker-managed volumes."
}

case "$#:$*" in
  0:)
    mode=enable
    ;;
  1:--reset)
    mode=reset
    ;;
  1:-h | 1:--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
env_file="${script_dir}/.env"
temp_file=

cleanup() {
  if [ -n "${temp_file}" ]; then
    rm -f "${temp_file}"
  fi
}

trap cleanup EXIT HUP INT TERM

filter_managed_variables() {
  if [ -f "${env_file}" ]; then
    awk '
      !/^[[:space:]]*QMD_DEVCONTAINER_CODEX_STATE[[:space:]]*[:=]/ &&
      !/^[[:space:]]*QMD_DEVCONTAINER_CLAUDE_STATE[[:space:]]*[:=]/
    ' "${env_file}" >"${temp_file}"
  fi
}

temp_file=$(mktemp "${env_file}.tmp.XXXXXX")
filter_managed_variables

if [ "${mode}" = reset ]; then
  if grep -q '[^[:space:]]' "${temp_file}"; then
    chmod 0600 "${temp_file}"
    mv "${temp_file}" "${env_file}"
    temp_file=
  else
    rm -f "${env_file}"
  fi

  echo "Docker-managed agent state restored."
  echo "Rebuild or reopen the development container to apply the mount change."
  exit 0
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

quote_env_value() {
  escaped=$(printf '%s' "$1" | sed "s/'/\\\\'/g")
  printf "'%s'" "${escaped}"
}

printf 'QMD_DEVCONTAINER_CODEX_STATE=%s\n' \
  "$(quote_env_value "${codex_state}")" >>"${temp_file}"
printf 'QMD_DEVCONTAINER_CLAUDE_STATE=%s\n' \
  "$(quote_env_value "${claude_state}")" >>"${temp_file}"

chmod 0600 "${temp_file}"
mv "${temp_file}" "${env_file}"
temp_file=

echo "Host-mounted agent state configured in ${env_file}:"
echo "  Codex: ${codex_state}"
echo "  Claude: ${claude_state}"
echo "Rebuild or reopen the development container to apply the mount change."
