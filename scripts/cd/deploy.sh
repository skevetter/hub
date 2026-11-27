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
    printf -- "- \`%s\`: \`%s\`\n" "$1" "$result" >> "$GITHUB_STEP_SUMMARY" || :
  fi
  printf '%s\n' "$result"
  return "$code"
}

external_smoke() {
  local health code url="${HUB_PUBLIC_URL%/}"
  health=$(mktemp "$RUNNER_TEMP/hub-health.XXXXXXXX") || return 1
  code=$(curl --silent --proto '=https' --max-time 20 -o /dev/null -w '%{http_code}' "$url") &&
    [[ "$code" == 200 ]] &&
    code=$(curl --silent --proto '=https' --max-time 20 -o "$health" -w '%{http_code}' "$url/health") &&
    [[ "$code" == 200 ]] && jq -e '.ok == true' "$health" >/dev/null 2>&1
  local result=$?
  rm -f -- "$health"
  return "$result"
}

wait_for_release() {
  local attempt code
  for ((attempt=1; attempt<=15; attempt++)); do
    code=0
    logged wait 60 >/dev/null || code=$?
    if [[ "$code" != 5 ]]; then return "$code"; fi
  done
  return 5
}

rollback_release() {
  local recovery to
  if ! { recovery=$(logged rollback) && wait_for_release && to=$(jq -er '.to' <<< "$recovery"); }; then
    echo "Rollback did not complete" >&2
    return 1
  fi
  smoke "$to" || echo "Rollback smoke failed" >&2
}

fail_deploy() {
  if [[ "$1" == rollback && "$MANUAL_DEPLOY" != true ]]; then
    rollback_release || :
  fi
  logged pause cd-failed >/dev/null || echo "Unable to pause deployment" >&2
  return 1
}

smoke() {
  logged smoke "$1" >/dev/null && external_smoke
}

mark_deployed() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'deployed=true\n' >> "$GITHUB_OUTPUT"; fi
}

finish_install() {
  local code=0
  wait_for_release || code=$?
  case "$code" in
    0) ;;
    3) fail_deploy rollback; return ;;
    5) echo "Install still running after 15 polls" >&2; fail_deploy pause; return ;;
    *) fail_deploy pause; return ;;
  esac
  smoke "$DEPLOY_VERSION" || { fail_deploy rollback; return; }
  logged record "$DEPLOY_VERSION" "$DEPLOY_SHA" >/dev/null || { fail_deploy pause; return; }
  mark_deployed || fail_deploy pause
}

validate_release() {
  cd_valid precheck "$DEPLOY_VERSION" "$DEPLOY_SHA" &&
    cd_valid install "$DEPLOY_VERSION" "$DEPLOY_CHECKSUM" &&
    [[ "$HUB_PUBLIC_URL" == https://* ]]
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
      if [[ "$MANUAL_DEPLOY" == true ]]; then
        if ! { smoke "$DEPLOY_VERSION" && mark_deployed; }; then
          fail_deploy pause
          return
        fi
      fi
      return 0
    fi
  fi
  logged precheck "$DEPLOY_VERSION" "$DEPLOY_SHA" >/dev/null
  logged quiet 600 >/dev/null
  logged backup "$DEPLOY_VERSION" >/dev/null
  local code=0
  logged install "$DEPLOY_VERSION" "$DEPLOY_CHECKSUM" >/dev/null || code=$?
  case "$code" in
    0) finish_install ;;
    2) return 2 ;;
    *) fail_deploy pause ;;
  esac
}

probe() {
  local code=0
  cd_selftest_probe "$1" >/dev/null || code=$?
  if [[ "$code" == 2 ]]; then
    printf 'PASS %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1"
    return 1
  fi
}

selftest() {
  local failed=0
  probe unknown-verb || failed=1
  probe overlong || failed=1
  probe older-version || failed=1
  return "$failed"
}

case "${1:-deploy}" in
  deploy) deploy ;;
  status|unpause) logged "$1" >/dev/null ;;
  pause) logged pause manual-pause >/dev/null ;;
  selftest) selftest ;;
  *) exit 2 ;;
esac
