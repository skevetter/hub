#!/usr/bin/env bash
set -euo pipefail

artifact="$1"
source_dir="$PWD"
scratch=$(mktemp -d "$RUNNER_TEMP/hub-install.XXXXXXXX")
trap 'rm -r -- "$scratch"' EXIT

tar -xzf "$artifact" -C "$scratch"
cmp npm-shrinkwrap.json "$scratch/package/npm-shrinkwrap.json"
cd "$scratch/package"
[[ ! -e .npmrc ]]
npm_config_userconfig="$scratch/user.npmrc" npm_config_globalconfig="$scratch/global.npmrc" \
  npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund
node "$source_dir/scripts/cd/verify-install.mjs" "$PWD"
