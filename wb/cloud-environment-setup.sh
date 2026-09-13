#!/usr/bin/env bash
# Paste into the cloud environment's "Setup script" field (claude.ai/code → cloud icon → environment settings).
# Runs once as root on a fresh Ubuntu 24.04 VM; the filesystem is then cached for later sessions.
# Network access must be Trusted (or Custom + default package managers).
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq postgresql-16 redis-server >/dev/null 2>&1 || true
npm install -g pnpm@10.28.1 >/dev/null 2>&1 || true
mkdir -p /home/claude/wb
# With GitHub connected to Claude Code these clone; without it they are skipped and the ZIP upload path is used instead.
for pair in "backend:hmodebdwie-byte/ASPR-backend-" "admin:hmodebdwie-byte/APSR-admin-" "frontend:hmodebdwie-byte/Tick-Trade-project-APSR"; do
  name=${pair%%:*}; repo=${pair##*:}
  [ -d "/home/claude/wb/$name/.git" ] || git clone -q --branch dev "https://github.com/$repo.git" "/home/claude/wb/$name" 2>/dev/null || echo "[setup] could not clone $repo (GitHub not connected?) — upload the ZIP instead"
done
# Pre-install dependencies so later sessions start warm (safe to fail; wb setup repeats it).
if [ -d /home/claude/wb/backend ]; then (cd /home/claude/wb/backend && pnpm install --frozen-lockfile >/dev/null 2>&1 || true); fi
if [ -d /home/claude/wb/frontend ]; then (cd /home/claude/wb/frontend && (npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 || npm ci --no-audit --no-fund --ignore-scripts --legacy-peer-deps >/dev/null 2>&1) || true); fi
if [ -d /home/claude/wb/admin ]; then (cd /home/claude/wb/admin && npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1 || true); fi
echo "[setup] done"
