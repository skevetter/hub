#!/usr/bin/env bash
set -euo pipefail

artifact="$1"
source_dir="$PWD"
prefix="$RUNNER_TEMP/hub-install"

tar -xOzf "$artifact" package/npm-shrinkwrap.json | cmp - npm-shrinkwrap.json
cd "$prefix"
npm_config_userconfig="$prefix/user.npmrc" npm_config_globalconfig="$prefix/global.npmrc" \
  npm install --global --prefix "$prefix" --legacy-peer-deps=false --no-audit --no-fund "$artifact"
node "$source_dir/scripts/cd/verify-install.mjs" "$source_dir/npm-shrinkwrap.json" "$prefix"
