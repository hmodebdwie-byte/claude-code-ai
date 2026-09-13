#!/usr/bin/env bash
# Recreate the TickTrade Workbench in a fresh Claude cloud session.
#   bash bootstrap.sh [uploads-dir]     (default: /mnt/user-data/uploads)
# Expects the three repo ZIPs (names containing "backend", "admin", "Tick-Trade") in the uploads dir,
# OR already-cloned repos at /home/claude/wb/{backend,admin,frontend}.
set -euo pipefail
WB=/home/claude/wb; UP="${1:-/mnt/user-data/uploads}"; HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$WB"; cp -rn "$HERE"/tools "$HERE"/monitor "$HERE"/patches "$HERE"/README.md "$HERE"/changes.json "$WB"/ 2>/dev/null || true
chmod +x "$WB/tools/wb.sh"; ln -sf "$WB/tools/wb.sh" /usr/local/bin/wb
unpack() { # name pattern
  local name="$1" pat="$2" zip
  [ -d "$WB/$name/.git" ] && { echo "[bootstrap] $name already present"; return; }
  zip="$(ls "$UP"/*"$pat"*.zip 2>/dev/null | head -1)" || true
  [ -n "$zip" ] || { echo "[bootstrap] no ZIP matching *$pat*.zip in $UP for $name" >&2; return 1; }
  local tmp; tmp="$(mktemp -d)"; unzip -q "$zip" -d "$tmp"
  local inner; inner="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  mv "$inner" "$WB/$name"; rm -rf "$tmp"
  (cd "$WB/$name" && git init -q && git add -A && git commit -qm "baseline: developer drop (as uploaded: $(basename "$zip"))")
  echo "[bootstrap] $name <- $(basename "$zip")"
}
unpack backend backend; unpack admin admin; unpack frontend Tick-Trade
# Re-apply recorded commits (patches/<repo>/NNNN-*.patch are `git format-patch` files).
# --keep-cr: several backend sources are CRLF; without it git am strips the CRs and the hunks no longer match.
for r in backend admin frontend; do
  for p in "$WB"/patches/"$r"/*.patch; do
    [ -f "$p" ] || continue
    (cd "$WB/$r" && git am -q --3way --keep-cr "$p" && echo "[bootstrap] $r applied $(basename "$p")") || { echo "[bootstrap] FAILED $p" >&2; (cd "$WB/$r" && git am --abort || true); }
  done
done
cd "$WB" && wb setup
