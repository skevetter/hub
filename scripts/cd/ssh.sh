#!/usr/bin/env bash

cd_version='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'

cd_ssh() {
  ssh -q -n -T -F /dev/null -p "$VPS2_SSH_PORT" -i "$RUNNER_TEMP/hub-deploy-key" \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes \
    -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ClearAllForwardings=yes -o GlobalKnownHostsFile=/dev/null \
    -o "UserKnownHostsFile=$RUNNER_TEMP/hub-deploy-known-hosts" \
    -- "hub-deploy@$VPS2_SSH_HOST" "$1" 2>/dev/null
}

cd_valid() {
  local command="$*"
  [[ $# -gt 0 && ${#command} -le 256 ]] || return 1
  case "$1" in
    status|rollback|unpause) [[ $# == 1 ]] ;;
    backup|smoke) [[ $# == 2 && "$2" =~ ^$cd_version$ ]] ;;
    precheck|record) [[ $# == 3 && "$2" =~ ^$cd_version$ && "$3" =~ ^[0-9a-f]{40}$ ]] ;;
    install) [[ $# == 3 && "$2" =~ ^$cd_version$ && "$3" =~ ^[0-9a-f]{64}$ ]] ;;
    quiet|wait) [[ $# == 2 ]] && cd_seconds "$1" "$2" ;;
    pause) [[ $# == 2 && "$2" =~ ^[a-z0-9-]{1,40}$ ]] ;;
    *) return 1 ;;
  esac
}

cd_seconds() {
  [[ "$2" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
  if [[ "$1" == quiet ]]; then
    [[ "$2" -le 600 ]]
  else
    [[ "$2" -ge 1 && "$2" -le 120 ]]
  fi
}

cd_exchange() {
  local result code=0
  result=$(cd_ssh "$2") || code=$?
  if [[ "$result" == *$'\n'* ]] || ! jq -es 'length == 1 and (.[0].ok | type == "boolean")' \
    <<< "$result" >/dev/null 2>&1; then
    echo "Deploy transport returned no valid reply" >&2
    return 4
  fi
  jq -ce --arg verb "$1" --argjson exit "$code" -f "$CD_DIR/reply.jq" \
    <<< "$result" 2>/dev/null || return 4
  return "$code"
}

cd_call() {
  cd_valid "$@" || return 2
  cd_exchange "$1" "$*"
}

cd_selftest_probe() {
  local line
  case "$1" in
    unknown-verb) line=unknown ;;
    overlong) printf -v line '%0300d' 0 ;;
    older-version) cd_call precheck 0.0.1 0000000000000000000000000000000000000000; return ;;
    *) return 4 ;;
  esac
  cd_exchange selftest "$line"
}
