#!/usr/bin/env bash
# Restart the backend services cleanly: kill every backend node process (wrappers AND children),
# then start them again. `wb restart` only kills the pid-file process and leaves stale children.
set -u
cd /home/claude/wb
# Never match this script's own shell or its parent (their command lines may quote these patterns).
targets() { pgrep -f -- "$1" | grep -vx "$$" | grep -vx "$PPID" || true; }
for pat in "dist/main.js" "dist/engine-worker/main.js" "apps/npc-worker" "dotenv/config"; do
  for pid in $(targets "$pat"); do kill "$pid" 2>/dev/null || true; done
done
sleep 3
for pat in "dist/main.js" "dist/engine-worker/main.js" "apps/npc-worker" "dotenv/config"; do
  for pid in $(targets "$pat"); do kill -9 "$pid" 2>/dev/null || true; done
done
sleep 1
(timeout 120 wb start api engine engine-worker settlement-worker npc-worker >/dev/null 2>&1 &)
sleep 35
wb status 2>&1 | head -8
echo "backend node processes: $(ps aux | grep -E 'dist/main.js|dist/engine-worker|apps/npc-worker|dotenv/config' | grep -v grep | wc -l) (expect 5)"
