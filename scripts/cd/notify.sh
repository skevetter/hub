#!/usr/bin/env bash
set -euo pipefail

title="$1"
body="$2"
outcome="${3:-}"
sha="${ALERT_SHA:-$GITHUB_SHA}"
if [[ ! "$sha" =~ ^[a-f0-9]{40}$ ]]; then sha="$GITHUB_SHA"; fi
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
commit_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/commit/$sha"

alert_message() {
  case "$outcome" in
    paused-precheck) echo "Precheck refused deployment because CD is paused." ;;
    rolled-back) echo "Deployment rolled back and passed rollback smoke. Check the run for pause status." ;;
    rollback-failed) echo "Rollback or its smoke check failed. Check the running version." ;;
    install-timeout) echo "The install exceeded its wait budget. Check its status before retrying." ;;
    record-failed) echo "The install passed smoke, but recording the deployment failed." ;;
    interrupted) echo "Deployment was interrupted after install may have started. Check the running version." ;;
    check-failed) echo "Required checks failed on main. No release was published by this run." ;;
    held) held_message ;;
    *) echo "The release or deployment did not complete." ;;
  esac
}

held_message() {
  if [[ "${HOLD_REASON:-}" == legacy-baseline ]]; then
    printf '%s\n' "Release v$VERSION is held: first release after the legacy baseline. Run \`cd-control status\` and \`selftest\`, then \`unpause\`. Dispatch \`main.yml\` from \`main\` with SHA $sha."
  else
    printf '%s\n' "Release v$VERSION is held for a rollback-unsafe change. Dispatch \`main.yml\` from \`main\` with SHA $sha."
  fi
}

if [[ $# == 3 ]]; then body="$(alert_message) [Workflow run]($body)"; fi
body="[\`${sha:0:7}\`]($commit_url): $body"

already_reported() {
  local last
  [[ "$outcome" == check-failed || "$outcome" == paused-precheck ]] || return 1
  last=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$issue/comments?per_page=100" |
    jq -sr 'add | last | if .user.login == "github-actions[bot]" then .body else "" end') || return 2
  [[ "$last" == *"$commit_url)"* ]]
}

issue=$(gh issue list --repo "$GITHUB_REPOSITORY" --label cd-alert --state open --limit 100 \
  --json title,number | jq -r --arg title "$title" '[.[] | select(.title == $title) | .number][0] // empty')
if [[ -n "$issue" ]]; then
  if already_reported; then exit 0; fi
  gh issue comment --repo "$GITHUB_REPOSITORY" "$issue" --body "$body"
else
  gh label create cd-alert --repo "$GITHUB_REPOSITORY" --color D93F0B \
    --description "Continuous deployment needs attention" 2>/dev/null ||
    gh api "repos/$GITHUB_REPOSITORY/labels/cd-alert" >/dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --label cd-alert --title "$title" --body "$body"
fi
