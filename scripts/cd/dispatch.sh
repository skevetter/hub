#!/usr/bin/env bash
set -euo pipefail

find_release_tag() {
  local tags
  tags=$(node scripts/cd/git.mjs at "$DEPLOY_SHA") || return
  [[ -n "$tags" && "$tags" != *$'\n'* ]] || return 1
  printf '%s\n' "$tags"
}

confirm_ci() {
  local runs jobs run
  runs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/workflows/main.yml/runs?head_sha=$DEPLOY_SHA&event=push&branch=main&per_page=100" \
    --jq '.workflow_runs[] | .id')
  while IFS= read -r run; do
    [[ -n "$run" ]] || continue
    jobs=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?per_page=100" \
      --jq '.jobs[] | select(.name == "check / required" and .conclusion == "success") | .id')
    if [[ -n "$jobs" ]]; then return 0; fi
  done <<< "$runs"
  echo "::error::No successful CI check found for the requested commit"
  return 1
}

read_release() {
  local tag="$1" version="${1#v}" file digest listing prerelease
  file="getpaseo-hub-$version.tgz"
  listing=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")
  digest=$(jq -er --arg file "$file" --arg tag "$tag" '
    def bot: . == "github-actions[bot]";
    def asset($name): [.assets[] | select(.name == $name and .state == "uploaded" and (.uploader.login | bot))] |
      select(length == 1) | .[0];
    select(.draft == false and .tag_name == $tag and (.author.login | bot)) |
    select(asset($file + ".sha256")) |
    asset($file).digest | select(type == "string" and test("\\Asha256:[0-9a-f]{64}\\z")) | ltrimstr("sha256:")
  ' <<< "$listing")
  prerelease=$(jq -r '.prerelease | if type == "boolean" then . else error("Invalid release type") end' <<< "$listing")
  gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$file.sha256" --dir "$RUNNER_TEMP"
  cmp -s "$RUNNER_TEMP/$file.sha256" <(printf '%s  %s\n' "$digest" "$file")
  printf 'version=%s\nchecksum=%s\nprerelease=%s\n' "$version" "$digest" "$prerelease" >> "$GITHUB_OUTPUT"
}

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/main
tag=$(find_release_tag)
confirm_ci
read_release "$tag"
