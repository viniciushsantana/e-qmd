#!/bin/sh
set -eu

# updateRemoteUserUID can remap the node account after the Dockerfile is built,
# while named volumes retain their original numeric owner. Repair only Docker-
# managed mounts; host-bound agent paths must keep their host ownership.
desired_owner="$(id -u node):$(id -g node)"

repair_named_volume() {
  mountpoint="$1"
  mkdir -p "${mountpoint}"

  if [ "$(stat -c '%u:%g' "${mountpoint}")" != "${desired_owner}" ]; then
    chown -R node:node "${mountpoint}"
  fi
}

for mountpoint in \
  /workspace/node_modules \
  /bun-cache \
  /home/node/.cache/qmd \
  /home/node/.config/qmd
do
  repair_named_volume "${mountpoint}"
done

if [ -z "${QMD_DEVCONTAINER_CODEX_STATE:-}" ]; then
  repair_named_volume /codex
fi

if [ -z "${QMD_DEVCONTAINER_CLAUDE_STATE:-}" ]; then
  repair_named_volume /claude
fi

exec docker-entrypoint.sh "$@"
