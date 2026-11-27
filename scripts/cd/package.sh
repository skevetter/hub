#!/usr/bin/env bash
set -euo pipefail

latest_tag() {
  node --input-type=module -e \
    'import {latestTag} from "./scripts/cd/git.mjs"; console.log(latestTag())'
}

rollback_unsafe() {
  local baseline="$1" sha matches commits
  if [[ -z "$baseline" && "${BEFORE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] &&
    git merge-base --is-ancestor "$BEFORE_SHA" HEAD 2>/dev/null; then
    baseline="$BEFORE_SHA"
  fi
  commits=$(git rev-list "${baseline:+$baseline..}HEAD") || return
  while IFS= read -r sha; do
    [[ -n "$sha" ]] || continue
    matches=$(gh api --paginate "repos/$GITHUB_REPOSITORY/commits/$sha/pulls" \
      --jq '.[] | select(.merged_at != null and .base.ref == "main") | .labels[] | select(.name == "rollback-unsafe") | .name') || return
    if [[ -n "$matches" ]]; then
      echo true
      return
    fi
  done <<< "$commits"
  echo false
}

plan() {
  local last tag ship held=false
  last=$(latest_tag)
  ship=$(node scripts/cd/ship-paths.mjs)
  if [[ "$GITHUB_REF" == refs/heads/main && "$ship" == false ]]; then
    echo "::notice::No shipped paths changed since the last release"
    echo "ship=false" >> "$GITHUB_OUTPUT"
    return
  fi
  tag=$(node scripts/cd/next-version.mjs)
  if [[ "$GITHUB_REF" == refs/heads/main && "$GITHUB_REPOSITORY" == skevetter/hub ]]; then
    held=$(rollback_unsafe "$last")
  fi
  printf 'ship=true\nbase_tag=%s\nversion=%s\nheld=%s\n' "$last" "${tag#v}" "$held" >> "$GITHUB_OUTPUT"
}

pack() {
  local version="$1" output="$2" file="getpaseo-hub-$1.tgz"
  mkdir -p "$output" "$RUNNER_TEMP/hub-install"
  npm version "$version" --no-git-tag-version --allow-same-version
  cp package-lock.json npm-shrinkwrap.json
  local files
  files=$(node -p 'require("./package.json").files.length')
  npm pkg set "files[$files]=npm-shrinkwrap.json"
  npm pack --pack-destination "$output"
  bash scripts/cd/verify-package.sh "$output/$file"
  (cd "$output" && sha256sum "$file" > "$file.sha256")
}

publish() {
  local version="$1" output="$2" file="getpaseo-hub-$1.tgz" tag existing
  tag=$(latest_tag)
  existing=$(git tag --list "v$version")
  [[ "$tag" == "$BASE_TAG" && -z "$existing" ]] || {
    echo "::error::A release was tagged while this package built; rerun packaging"
    return 1
  }
  [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
  (cd "$output" && sha256sum --check --strict "$file.sha256")
  node scripts/cd/release-notes.mjs > "$RUNNER_TEMP/hub-release-notes.md"
  gh release create "v$version" "$output/$file" "$output/$file.sha256" \
    --target "$GITHUB_SHA" --repo "$GITHUB_REPOSITORY" --notes-file "$RUNNER_TEMP/hub-release-notes.md" \
    --title "v$version"
}

case "$1" in
  plan) plan ;;
  pack) pack "$2" "$3" ;;
  publish) publish "$2" "$3" ;;
  *) exit 2 ;;
esac
