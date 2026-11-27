#!/usr/bin/env bash

cd_ssh() {
  ssh -q -n -T -F /dev/null -p "$VPS2_SSH_PORT" -i "$RUNNER_TEMP/hub-deploy-key" \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes \
    -o ClearAllForwardings=yes -o GlobalKnownHostsFile=/dev/null \
    -o "UserKnownHostsFile=$RUNNER_TEMP/hub-deploy-known-hosts" \
    -- "hub-deploy@$VPS2_SSH_HOST" "$1" 2>/dev/null
}

cd_call() {
  local result code=0
  result=$(cd_ssh "$*") || code=$?
  if ! jq -es 'length == 1 and (.[0].ok | type == "boolean")' <<< "$result" >/dev/null 2>&1; then
    echo "Deploy transport returned no valid reply" >&2
    return 4
  fi
  jq -c --arg verb "$1" -f "$CD_DIR/reply.jq" <<< "$result" 2>/dev/null || return 4
  case "$code" in
    0) jq -e '.ok' <<< "$result" >/dev/null || return 4 ;;
    2|3|4) jq -e '.ok == false' <<< "$result" >/dev/null || return 4 ;;
    *) return 4 ;;
  esac
  return "$code"
}
