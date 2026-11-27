#!/usr/bin/env bash
set -euo pipefail

find_release_tag() {
  local tag
  local -a tags=()
  while IFS= read -r tag; do
    if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then tags+=("$tag"); fi
  done < <(git tag --points-at "$DEPLOY_SHA" --list 'v[0-9]*')
  [[ "${#tags[@]}" == 1 ]] || return 1
  printf '%s\n' "${tags[0]}"
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
  local tag="$1" version="${1#v}" file digest listing
  file="getpaseo-hub-$version.tgz"
  listing=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag")
  digest=$(jq -er --arg file "$file" '
    select(.draft == false) | .assets[] | select(.name == $file and .state == "uploaded") |
    .digest | select(test("^sha256:[0-9a-f]{64}$")) | ltrimstr("sha256:")
  ' <<< "$listing")
  gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$file.sha256" --dir "$RUNNER_TEMP"
  grep -Fx -- "$digest  $file" "$RUNNER_TEMP/$file.sha256" >/dev/null
  printf 'version=%s\nchecksum=%s\n' "$version" "$digest" >> "$GITHUB_OUTPUT"
}

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/main
tag=$(find_release_tag)
confirm_ci
read_release "$tag"
