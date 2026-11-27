#!/usr/bin/env bash
set -euo pipefail

CD_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/cd/ssh.sh
source "$CD_DIR/ssh.sh"

install_attempted=false
deployed=false

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

# Wait in the parent shell so its signal trap can run while the call is in flight.
wait_bg() {
  "$@" &
  wait "$!"
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
    wait_bg logged wait 60 >/dev/null || code=$?
    if [[ "$code" != 5 ]]; then return "$code"; fi
  done
  return 5
}

rollback_release() {
  local reply to code=0
  reply=$(mktemp "$RUNNER_TEMP/hub-rollback.XXXXXXXX") || return 1
  wait_bg logged rollback > "$reply" && wait_for_release && to=$(jq -er '.to' "$reply") || code=$?
  rm -f -- "$reply"
  if [[ "$code" != 0 ]]; then
    echo "Rollback did not complete" >&2
    return 1
  fi
  "$1" "$to" || { echo "Rollback verification failed" >&2; return 1; }
}

pause_failed() {
  logged pause cd-failed >/dev/null
}

fail_deploy() {
  local outcome="${2:-}"
  if [[ "$1" == rollback && "${PRERELEASE:-false}" != true ]]; then
    if rollback_release smoke; then outcome=rolled-back; else outcome=rollback-failed; fi
  fi
  if [[ -n "$outcome" ]]; then mark_output outcome "$outcome" || :; fi
  pause_failed || echo "Unable to pause deployment" >&2
  return 1
}

smoke() {
  wait_bg logged smoke "$1" >/dev/null && wait_bg external_smoke
}

verify_rollback() {
  local status version
  status=$(logged status) || return 1
  version=$(jq -er --arg to "$1" 'select(.paused and .version == $to) | .version' <<< "$status") ||
    { echo "Rollback target is not running or deploys are not paused" >&2; return 1; }
  wait_bg logged smoke "$version" >/dev/null
}

manual_rollback() {
  local result=completed code=0
  if ! { pause_failed && rollback_release verify_rollback; }; then
    result=failed
    code=1
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '\nRollback %s.\n' "$result" >> "$GITHUB_STEP_SUMMARY" || :
  fi
  return "$code"
}

mark_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf '%s=%s\n' "$1" "${2:-true}" >> "$GITHUB_OUTPUT"; fi
}

handle_interruption() {
  trap '' INT TERM
  if [[ "$install_attempted" == true && "$deployed" != true ]]; then
    pause_failed || echo "Unable to pause deployment after interruption" >&2
    mark_output outcome interrupted || :
  fi
  exit "$1"
}

record_deployment() {
  if ! wait_bg logged record "$DEPLOY_VERSION" "$DEPLOY_SHA" >/dev/null; then
    fail_deploy pause record-failed
    return
  fi
  deployed=true
  mark_output deployed
}

finish_install() {
  local code=0
  wait_for_release || code=$?
  case "$code" in
    0) ;;
    3) fail_deploy rollback; return ;;
    5) echo "Install still running after 15 polls" >&2; fail_deploy pause install-timeout; return ;;
    *) fail_deploy pause; return ;;
  esac
  smoke "$DEPLOY_VERSION" || { fail_deploy rollback; return; }
  record_deployment
}

validate_release() {
  cd_valid precheck "$DEPLOY_VERSION" "$DEPLOY_SHA" &&
    cd_valid install "$DEPLOY_VERSION" "$DEPLOY_CHECKSUM" &&
    [[ "$HUB_PUBLIC_URL" == https://* ]]
}

check_running() {
  local running="$1" ancestry=0
  git merge-base --is-ancestor "$running" "$DEPLOY_SHA" 2>/dev/null || ancestry=$?
  if [[ "$ancestry" == 1 ]]; then
    echo "::notice::Skipping superseded release"
    if [[ "$MANUAL_DEPLOY" == true ]]; then exit 1; fi
    exit 0
  fi
  [[ "$ancestry" == 0 ]] || exit 1
  if [[ "$running" != "$DEPLOY_SHA" ]]; then return; fi
  echo "::notice::Release already recorded"
  if [[ "$MANUAL_DEPLOY" == true ]]; then
    if ! { smoke "$DEPLOY_VERSION" && mark_output deployed; }; then
      fail_deploy pause
    fi
  fi
  exit 0
}

install_release() {
  local code=0
  trap 'handle_interruption 130' INT
  trap 'handle_interruption 143' TERM
  mark_output install_attempted
  install_attempted=true
  wait_bg logged install "$DEPLOY_VERSION" "$DEPLOY_CHECKSUM" >/dev/null || code=$?
  case "$code" in
    0) finish_install ;;
    2)
      install_attempted=false
      mark_output install_attempted false
      return 2 ;;
    *) fail_deploy pause ;;
  esac
}

precheck() {
  local reply code=0
  reply=$(logged precheck "$DEPLOY_VERSION" "$DEPLOY_SHA") || code=$?
  if [[ "$code" == 2 ]] && jq -e '.reason == "paused"' <<< "$reply" >/dev/null; then
    mark_output outcome paused-precheck
  fi
  return "$code"
}

deploy() {
  local status running
  validate_release
  status=$(logged status)
  running=$(jq -r '.commit // empty' <<< "$status")
  if [[ -n "$running" ]]; then check_running "$running"; fi
  precheck
  logged quiet 600 >/dev/null
  logged backup "$DEPLOY_VERSION" >/dev/null
  install_release
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
  pause-failed) pause_failed ;;
  rollback) manual_rollback ;;
  selftest) selftest ;;
  *) exit 2 ;;
esac
