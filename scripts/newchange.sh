#!/bin/sh

set -eu

branch_name="${1:-}"

if [ -z "$branch_name" ]; then
  echo "Usage: npm run newchange -- <branch-name>" >&2
  exit 1
fi

if ! git rev-parse --verify main >/dev/null 2>&1; then
  echo "Local branch 'main' does not exist." >&2
  exit 1
fi

current_branch="$(git branch --show-current)"

if [ "$current_branch" != "main" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Commit or stash your changes before switching branches." >&2
    exit 1
  fi

  git switch main
fi

git switch -c "$branch_name"
