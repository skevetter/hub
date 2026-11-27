#!/usr/bin/env bash
set -euo pipefail

CD_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/cd/ssh.sh
source "$CD_DIR/ssh.sh"

logged() {
  local result code=0
  result=$(cd_call "$@") || code=$?
  printf '%s %s\n' "$1" "$result" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf -- "- \`%s\`: \`%s\`\n" "$1" "$result" >> "$GITHUB_STEP_SUMMARY"
  fi
  printf '%s\n' "$result"
  return "$code"
}

external_smoke() {
  local health code url="${HUB_PUBLIC_URL%/}"
  health=$(mktemp "$RUNNER_TEMP/hub-health.XXXXXXXX")
  code=$(curl --silent --proto '=https' --max-time 20 -o /dev/null -w '%{http_code}' "$url") &&
    [[ "$code" == 200 ]] &&
    code=$(curl --silent --proto '=https' --max-time 20 -o "$health" -w '%{http_code}' "$url/health") &&
    [[ "$code" == 200 ]] && jq -e '.ok == true' "$health" >/dev/null 2>&1
  local result=$?
  rm -f -- "$health"
  return "$result"
}

wait_for_release() {
  local result
  result=$(logged wait 900) && jq -e '.state == "done"' <<< "$result" >/dev/null
}

recover() {
  local recovery to
  if [[ "$MANUAL_DEPLOY" != true ]]; then
    if recovery=$(logged rollback) && wait_for_release; then
      if to=$(jq -er '.to' <<< "$recovery"); then
        logged smoke "$to" >/dev/null && external_smoke || echo "Rollback smoke failed" >&2
      else
        echo "Rollback returned no version" >&2
      fi
    else
      echo "Rollback did not complete" >&2
    fi
  fi
  logged pause "cd-failed-${DEPLOY_SHA:0:12}" >/dev/null || echo "Unable to pause deployment" >&2
  return 1
}

validate_release() {
  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ && "$DEPLOY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [[ "$DEPLOY_CHECKSUM" =~ ^[0-9a-f]{64}$ && "$HUB_PUBLIC_URL" == https://* ]]
}

deploy() {
  local status running ancestry=0
  validate_release
  status=$(logged status)
  running=$(jq -r '.commit // empty' <<< "$status")
  if [[ -n "$running" ]]; then
    git merge-base --is-ancestor "$running" "$DEPLOY_SHA" 2>/dev/null || ancestry=$?
    if [[ "$ancestry" == 1 ]]; then
      echo "::notice::Skipping superseded release"
      return 0
    fi
    [[ "$ancestry" == 0 ]]
    if [[ "$running" == "$DEPLOY_SHA" ]]; then
      echo "::notice::Release already recorded"
      return 0
    fi
  fi
  logged precheck "$DEPLOY_VERSION" "$DEPLOY_SHA" >/dev/null
  logged quiet 600 >/dev/null
  logged backup "$DEPLOY_VERSION" >/dev/null
  logged install "$DEPLOY_VERSION" "$DEPLOY_CHECKSUM" >/dev/null
  wait_for_release
  if logged smoke "$DEPLOY_VERSION" >/dev/null && external_smoke; then
    logged record "$DEPLOY_VERSION" "$DEPLOY_SHA" >/dev/null
  else
    recover
  fi
}

probe() {
  local code=0
  cd_call "$2" >/dev/null || code=$?
  if [[ "$code" == 2 ]]; then
    printf 'PASS %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1"
    return 1
  fi
}

selftest() {
  local failed=0 long
  printf -v long '%0300d' 0
  probe unknown-verb 'unknown' || failed=1
  probe overlong "$long" || failed=1
  probe older-version 'precheck 0.0.1 0000000000000000000000000000000000000000' || failed=1
  return "$failed"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  status|unpause) logged "$1" >/dev/null ;;
  pause) logged pause manual-pause >/dev/null ;;
  selftest) selftest ;;
  *) exit 2 ;;
esac
