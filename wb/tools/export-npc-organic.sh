#!/usr/bin/env bash
# Export the organic NPC engine drop: one patch per repo (numbered after the existing ones),
# a git-archive ZIP per repo, and a copy of the patches into the workbench git repo.
set -euo pipefail
WB=/home/claude/wb
WBGIT=/home/user/claude-code-ai/wb
DATE=$(date -u +%Y-%m-%d)
declare -A NAME=( [backend]=ASPR-backend- [admin]=APSR-admin- [frontend]=Tick-Trade-project-APSR )
for r in backend admin frontend; do
  cd "$WB/$r"
  n=$(ls "$WB/patches/$r"/*.patch 2>/dev/null | wc -l)
  git format-patch -1 HEAD --start-number $((n + 1)) -o "$WB/patches/$r" >/dev/null
  mkdir -p "$WBGIT/patches/$r"
  cp "$WB/patches/$r"/*.patch "$WBGIT/patches/$r/"
  zip="$WB/export/${NAME[$r]}-dev-npc-organic-$DATE.zip"
  git archive --format=zip --prefix="${NAME[$r]}/" -o "$zip" HEAD
  echo "$r: $(git log --oneline -1) → $(ls "$WB/patches/$r" | tail -1), $(du -h "$zip" | cut -f1) $(basename "$zip")"
done
