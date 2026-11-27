#!/usr/bin/env bash
set -euo pipefail

rollback_baseline() {
  local releases tags tag legacy=""
  releases=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name') || return
  tags=$(node scripts/cd/git.mjs merged) || return
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    if grep -Fxq -- "$tag" <<< "$releases"; then
      printf '%s\n' "$tag"
      return
    fi
    if [[ "$tag" == v0.* && -z "$legacy" ]]; then legacy=$tag; fi
  done <<< "$tags"
  printf '%s\n' "$legacy"
}

rollback_unsafe() {
  local baseline scan sha matches commits
  baseline=$(rollback_baseline) || return
  scan=$(BASE_SHA="$baseline" ROLLBACK_UNSAFE=false node scripts/cd/check-migrations.mjs --release) || return
  if [[ "$scan" == true ]]; then
    echo true
    return
  fi
  [[ "$scan" == false ]] || return 1
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
  last=$(node scripts/cd/git.mjs latest)
  ship=$(node scripts/cd/ship-paths.mjs)
  if [[ "$GITHUB_REF" == refs/heads/main && "$ship" == false ]]; then
    echo "::notice::No shipped paths changed since the last release"
    echo "ship=false" >> "$GITHUB_OUTPUT"
    return
  fi
  tag=$(node scripts/cd/next-version.mjs)
  if [[ "$GITHUB_REF" == refs/heads/main && "$GITHUB_REPOSITORY" == skevetter/hub ]]; then
    held=$(rollback_unsafe)
  fi
  printf 'ship=true\nbase_tag=%s\nversion=%s\nheld=%s\n' "$last" "${tag#v}" "$held" >> "$GITHUB_OUTPUT"
}

pack() {
  local version="$1" output="$2" file="getpaseo-hub-$1.tgz"
  mkdir -p "$output"
  npm version "$version" --no-git-tag-version --allow-same-version
  cp package-lock.json npm-shrinkwrap.json
  local files
  files=$(node -p 'require("./package.json").files.length')
  npm pkg set "files[$files]=npm-shrinkwrap.json"
  npm pack --pack-destination "$output"
  bash scripts/cd/verify-package.sh "$output/$file"
  (cd "$output" && sha256sum "$file" > "$file.sha256")
}

confirm_publish_order() {
  local tags newest=""
  tags=$(node scripts/cd/git.mjs all) || return
  newest=${tags%%$'\n'*}
  if [[ "$newest" != "$BASE_TAG" || "$newest" == "v$1" ]] ||
    { [[ -n "$newest" ]] && ! git merge-base --is-ancestor "$newest" HEAD; }; then
    echo "::error::A release was tagged while this package built; rerun packaging"
    return 1
  fi
}

confirm_checksum() {
  local file="$1" checksum
  [[ "$EXPECTED_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || return 1
  checksum=$(sha256sum "$file") || return
  [[ "${checksum%% *}" == "$EXPECTED_CHECKSUM" ]] &&
    cmp -s "$file.sha256" <(printf '%s  %s\n' "$EXPECTED_CHECKSUM" "${file##*/}")
}

publish() {
  local version="$1" output="$2" file="getpaseo-hub-$1.tgz"
  local -a options=()
  [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
  confirm_publish_order "$version"
  confirm_checksum "$output/$file"
  node scripts/cd/release-notes.mjs > "$RUNNER_TEMP/hub-release-notes.md"
  if [[ "${HELD:?Expected release hold status}" == true ]]; then options+=(--prerelease); fi
  gh release create "v$version" "$output/$file" "$output/$file.sha256" \
    --target "$GITHUB_SHA" --repo "$GITHUB_REPOSITORY" --notes-file "$RUNNER_TEMP/hub-release-notes.md" \
    --title "v$version" "${options[@]}"
}

case "$1" in
  plan) plan ;;
  pack) pack "$2" "$3" ;;
  verify) confirm_checksum "$3/getpaseo-hub-$2.tgz" ;;
  publish) publish "$2" "$3" ;;
  *) exit 2 ;;
esac
