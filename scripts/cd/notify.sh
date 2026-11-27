#!/usr/bin/env bash
set -euo pipefail

title="$1"
body="$2"
issue=$(gh issue list --repo "$GITHUB_REPOSITORY" --label cd-alert --state open --limit 100 \
  --json title,number | jq -r --arg title "$title" '[.[] | select(.title == $title) | .number][0] // empty')
if [[ -n "$issue" ]]; then
  gh issue comment --repo "$GITHUB_REPOSITORY" "$issue" --body "$body"
else
  gh label create cd-alert --repo "$GITHUB_REPOSITORY" --color D93F0B \
    --description "Continuous deployment needs attention" 2>/dev/null ||
    gh api "repos/$GITHUB_REPOSITORY/labels/cd-alert" >/dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --label cd-alert --title "$title" --body "$body"
fi
