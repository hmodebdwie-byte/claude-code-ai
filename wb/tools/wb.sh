#!/usr/bin/env bash
# TickTrade Workbench — one CLI to install, build, run, test and probe the whole stack.
#
#   wb setup            full bring-up (prereqs, db, install, generate, migrate, seed, build, start)
#   wb install          pnpm/npm install for backend, frontend, admin
#   wb env              (re)generate local .env files (keeps existing secrets)
#   wb db:migrate       prisma migrate deploy
#   wb db:seed          seed admin + cooldown + content templates + synthetic fixtures
#   wb db:reset         DROP and recreate the local database, then migrate + seed
#   wb build [what]     backend | frontend | admin | all (default all)
#   wb start [svc...]   start services (default: all)
#   wb stop  [svc...]   stop services
#   wb restart [svc...] restart services
#   wb status           table of services with pid / port / health
#   wb logs <svc> [n]   tail service log
#   wb test [suite]     api | engine | shared | admin-regression | all
#   wb probe            collect a JSON snapshot of the running stack -> wb/snapshots/latest.json
#   wb ports            print the local URLs
#
# Services: api engine engine-worker settlement-worker npc-worker frontend admin
# Layout:   /home/claude/wb/{backend,admin,frontend}  (git repos, branch dev)
#           /home/claude/wb/env/backend.env            (generated; secrets are local-only)
#           /home/claude/wb/run/{pids,logs}
set -uo pipefail

WB_ROOT="${WB_ROOT:-/home/claude/wb}"
BACKEND="$WB_ROOT/backend"; ADMIN="$WB_ROOT/admin"; FRONTEND="$WB_ROOT/frontend"
TOOLS="$WB_ROOT/tools"; RUN="$WB_ROOT/run"; ENVDIR="$WB_ROOT/env"; SNAPS="$WB_ROOT/snapshots"
mkdir -p "$RUN/pids" "$RUN/logs" "$ENVDIR" "$SNAPS"

API_PORT=18773; FRONTEND_PORT=18771; ADMIN_PORT=18772
DB_NAME=ticktrade_local; DB_USER=ticktrade; DB_PASS=ticktrade_local
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
REDIS_URL="redis://127.0.0.1:6379"
ALL_SERVICES=(api engine engine-worker settlement-worker npc-worker frontend admin)

log()  { printf '\033[1;36m[wb]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[wb]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[wb]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
cmd_prereqs() {
  command -v node >/dev/null || die "node missing"
  command -v pnpm >/dev/null || npm install -g pnpm@10.28.1
  command -v psql >/dev/null || die "postgresql-client missing (apt-get install postgresql-16)"
  command -v redis-server >/dev/null || die "redis-server missing (apt-get install redis-server)"
  # Postgres cluster
  if ! pg_lsclusters 2>/dev/null | grep -q online; then
    pg_ctlcluster 16 main start 2>/dev/null || service postgresql start
  fi
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1 || \
    su postgres -c "psql -qc \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' SUPERUSER\""
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1 || \
    su postgres -c "psql -qc \"CREATE DATABASE $DB_NAME OWNER $DB_USER\""
  # Redis
  redis-cli -p 6379 ping >/dev/null 2>&1 || \
    redis-server --daemonize yes --port 6379 --bind 127.0.0.1 --save "" --appendonly no --logfile "$RUN/logs/redis.log" >/dev/null
  log "postgres + redis ready ($DATABASE_URL, $REDIS_URL)"
}

# ---------------------------------------------------------------- env files
rand() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
cmd_env() {
  local f="$ENVDIR/backend.env"
  if [ ! -f "$f" ]; then
    cat > "$f" <<EOF
NODE_ENV=development
PORT=$API_PORT
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
JWT_SECRET=$(rand 32)
JWT_EXPIRES_IN=7d
ENC_KEY=$(rand 16)
FRONTEND_URL=http://127.0.0.1:$FRONTEND_PORT
SWAGGER_PATH=docs
TRUST_PROXY_HOPS=0
TS_NODE_PREFER_TS_EXTS=true
ENGINE_DB_RETRY_MAX=12
NPC_WORKER_ENABLED=1
RPC_SESSION_SCHEDULER_ENABLED=false
TICKTRADE_LOCAL_FIXTURES=1
SEED_ADMIN_EMAIL=local-admin@ticktrade.test
SEED_ADMIN_NAME="Local Admin (synthetic)"
SEED_ADMIN_PASSWORD=Admin-$(rand 8)
SEED_DEMO_EMAIL=local-demo@ticktrade.test
SEED_DEMO_PASSWORD=Demo-$(rand 8)
LOG_LEVEL=info
EOF
    chmod 600 "$f"
    log "generated $f (local-only synthetic secrets)"
  fi
  # Every process resolves .env from these locations (see apps/api/src/load-env.ts,
  # apps/npc-worker/src/preload-env.ts, scripts/start-*.sh). Keep them identical.
  for target in "$BACKEND/.env" "$BACKEND/apps/api/.env" "$BACKEND/apps/engine/.env" \
                "$BACKEND/apps/settlement-worker/.env" "$BACKEND/apps/npc-worker/.env"; do
    cp "$f" "$target"
  done
  printf 'VITE_APP_API_URL=http://127.0.0.1:%s\nVITE_APP_Sokect_URL=http://127.0.0.1:%s\n' "$API_PORT" "$API_PORT" > "$FRONTEND/.env.production.local"
  printf 'VITE_APP_API_URL=http://127.0.0.1:%s\nVITE_APP_Sokect_URL=http://127.0.0.1:%s\n' "$API_PORT" "$API_PORT" > "$ADMIN/.env.production.local"
  log "env files written into backend/, frontend/, admin/"
}
envload() { set -a; . "$ENVDIR/backend.env"; set +a; }

# ---------------------------------------------------------------- install / build
cmd_install() {
  # The repo's .npmrc sets symlink=false (a Windows workaround). On Linux that leaves the
  # isolated pnpm layout unresolvable (the @prisma/engines postinstall cannot find @prisma/debug),
  # so the workbench overrides it on the command line without touching the repo file.
  log "backend: pnpm install --frozen-lockfile (--config.symlink=true)"
  (cd "$BACKEND" && pnpm install --frozen-lockfile --config.symlink=true) || die "backend install failed"
  log "frontend: npm ci (with the eslint-plugin-react-hooks fix applied it is clean; otherwise legacy-peer-deps)"
  (cd "$FRONTEND" && (npm ci --no-audit --no-fund --ignore-scripts || npm ci --no-audit --no-fund --ignore-scripts --legacy-peer-deps)) || die "frontend install failed"
  log "admin: npm ci"
  (cd "$ADMIN" && npm ci --no-audit --no-fund --ignore-scripts) || die "admin install failed"
}
cmd_generate() { (cd "$BACKEND" && envload && pnpm run prisma:generate) || die "prisma generate failed"; }
cmd_build() {
  local what="${1:-all}"
  if [[ "$what" == all || "$what" == backend ]]; then
    log "backend: build shared, ws-contracts, platform-core, npc-intelligence, api"
    (cd "$BACKEND" && envload && pnpm run prisma:generate \
      && pnpm --filter @ticktrade/shared build && pnpm --filter @ticktrade/ws-contracts build \
      && pnpm --filter @ticktrade/platform-core build && pnpm --filter @ticktrade/npc-intelligence build \
      && pnpm --filter api build) || die "backend build failed"
  fi
  # env/backend.env sets NODE_ENV=development for the API. If it is exported when
  # vite runs, `import.meta.env.PROD` is false and the build silently drops the
  # PWA registration (no service worker, no precache, no "Update now" prompt) -
  # it still exits 0, so nothing tells you. Unset it for the web builds.
  if [[ "$what" == all || "$what" == frontend ]]; then
    log "frontend: vite build"; (cd "$FRONTEND" && env -u NODE_ENV npm run build) || die "frontend build failed"
  fi
  if [[ "$what" == all || "$what" == admin ]]; then
    log "admin: vite build"; (cd "$ADMIN" && env -u NODE_ENV npm run build) || die "admin build failed"
  fi
  date -u +%FT%TZ > "$RUN/last-build.txt"
}

# ---------------------------------------------------------------- database
cmd_db_migrate() { (cd "$BACKEND" && envload && pnpm run prisma:migrate:deploy) || die "migrate failed"; }
cmd_db_seed() {
  # seed:content-templates imports @ticktrade/shared, so the shared package must be built first.
  [ -d "$BACKEND/packages/shared/dist" ] || (cd "$BACKEND" && envload && pnpm run build:shared) || die "shared build failed"
  (cd "$BACKEND" && envload && pnpm run seed:admin && pnpm run seed:cooldown && pnpm run seed:content-templates \
     && node "$TOOLS/fixtures.cjs") || die "seed failed"
}
cmd_db_reset() {
  cmd_stop
  su postgres -c "psql -qc \"DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)\""
  su postgres -c "psql -qc \"CREATE DATABASE $DB_NAME OWNER $DB_USER\""
  redis-cli FLUSHALL >/dev/null
  cmd_db_migrate && cmd_db_seed
}

# ---------------------------------------------------------------- services
svc_cmd() {  # prints: cwd|command
  case "$1" in
    api)               echo "$BACKEND/apps/api|node dist/main.js";;
    engine)            echo "$BACKEND|bash scripts/start-engine.sh";;
    engine-worker)     echo "$BACKEND/apps/api|node dist/engine-worker/main.js";;
    settlement-worker) echo "$BACKEND|bash scripts/start-settlement-worker.sh";;
    npc-worker)        echo "$BACKEND|bash scripts/start-npc-worker.sh";;
    rpc-worker)        echo "$BACKEND/apps/api|node dist/rpc-worker/main.js";;
    frontend)          echo "$FRONTEND|node $TOOLS/static-server.cjs $FRONTEND/dist $FRONTEND_PORT";;
    admin)             echo "$ADMIN|node $TOOLS/static-server.cjs $ADMIN/dist $ADMIN_PORT";;
    *) return 1;;
  esac
}
# The PID file holds the service's OWN pid (svc_start has the started shell write
# $$ and then exec, so the pid survives the exec). `setsid` forks, so the old
# `echo $!` recorded the setsid wrapper, which exits immediately - stop/restart
# then silently did nothing and left the real process running on the port.
# Also confirm the pid is still the service we started: pids get recycled, and a
# stale file must never make `wb stop` kill an unrelated process.
svc_pid() {
  local f="$RUN/pids/$1.pid" pid
  [ -f "$f" ] || return 1
  pid="$(cat "$f" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "WB_SERVICE=$1" || return 1
  printf '%s' "$pid"
}
svc_start() {
  local s="$1" spec cwd cmd
  spec="$(svc_cmd "$s")" || die "unknown service $s"
  cwd="${spec%%|*}"; cmd="${spec#*|}"
  if svc_pid "$s" >/dev/null; then log "$s already running (pid $(svc_pid "$s"))"; return; fi
  rm -f "$RUN/pids/$s.pid"
  # The subshell points its OWN stdin/stdout/stderr at the log before it forks
  # anything, so no descendant can hold the caller's stdout. Without this,
  # `wb start api | tail` hung forever: the service inherited the pipe's write
  # end and tail never saw EOF, even though the service only wrote to its log.
  # The started shell records its own pid and then execs, so the pid file holds
  # the real service pid and not the setsid wrapper's - that is what made
  # `wb stop` and `wb restart` silently do nothing.
  ( exec </dev/null >>"$RUN/logs/$s.log" 2>&1
    cd "$cwd" && envload && export PORT="$API_PORT" && export WB_SERVICE="$s" && \
      setsid bash -c "echo \$\$ > '$RUN/pids/$s.pid'; exec $cmd" & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$RUN/pids/$s.pid" ] && break; sleep 0.2; done
  log "started $s (pid $(cat "$RUN/pids/$s.pid" 2>/dev/null || echo '?')) -> $RUN/logs/$s.log"
}
svc_stop() {
  local s="$1" pid
  pid="$(svc_pid "$s")" || { rm -f "$RUN/pids/$s.pid"; return; }
  kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 -- -"$pid" 2>/dev/null; rm -f "$RUN/pids/$s.pid"; log "stopped $s"
}
cmd_start()   { local list=("${@:-${ALL_SERVICES[@]}}"); [ $# -eq 0 ] && list=("${ALL_SERVICES[@]}"); for s in "${list[@]}"; do svc_start "$s"; [ "$s" = api ] && wait_http "http://127.0.0.1:$API_PORT/" 60; done; }
cmd_stop()    { local list=("${@:-${ALL_SERVICES[@]}}"); [ $# -eq 0 ] && list=("${ALL_SERVICES[@]}"); for s in "${list[@]}"; do svc_stop "$s"; done; }
cmd_restart() { cmd_stop "$@"; cmd_start "$@"; }
wait_http() { local url="$1" n="${2:-30}"; for ((i=0;i<n;i++)); do curl -s -o /dev/null -m 2 "$url" && return 0; sleep 1; done; warn "timeout waiting for $url"; return 1; }
cmd_status() {
  printf '%-18s %-8s %-6s %s\n' SERVICE STATE PID HEALTH
  for s in "${ALL_SERVICES[@]}"; do
    local pid state health=""
    pid="$(svc_pid "$s")" && state=up || { state=down; pid=-; }
    case "$s" in
      api)      health="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$API_PORT/" 2>/dev/null || echo err)";;
      frontend) health="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$FRONTEND_PORT/" 2>/dev/null || echo err)";;
      admin)    health="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$ADMIN_PORT/" 2>/dev/null || echo err)";;
      *)        health="$(tail -n 1 "$RUN/logs/$s.log" 2>/dev/null | cut -c1-70)";;
    esac
    printf '%-18s %-8s %-6s %s\n' "$s" "$state" "$pid" "$health"
  done
  printf '%-18s %-8s %-6s %s\n' postgres "$(pg_lsclusters 2>/dev/null | awk 'NR==2{print ($4=="online")?"up":"down"}')" - "$DB_NAME"
  printf '%-18s %-8s %-6s %s\n' redis "$(redis-cli ping >/dev/null 2>&1 && echo up || echo down)" - "$REDIS_URL"
}
cmd_logs() { local s="${1:?service}" n="${2:-80}"; tail -n "$n" "$RUN/logs/$s.log"; }

# ---------------------------------------------------------------- tests
TSX_LOADER="${TSX_LOADER:-$(npm root -g 2>/dev/null)/tsx/dist/loader.mjs}"
# Offline mode: no node_modules yet (registry blocked). Pure-logic suites (shared, most of engine)
# still run through the globally installed tsx with workspace aliases mapped to package sources.
offline_test() {  # name glob
  TSX_TSCONFIG_PATH="$TOOLS/tsconfig.offline.json" node --import "$TSX_LOADER" --test --test-concurrency=2 "$2" 2>&1 | tee "$RUN/tests/$1.log"; return "${PIPESTATUS[0]}"
}
cmd_test() {
  local suite="${1:-all}" rc=0
  mkdir -p "$RUN/tests"
  if [ ! -d "$BACKEND/node_modules" ]; then
    warn "backend node_modules missing — running the dependency-free suites offline via tsx (api/jest skipped)"
    if [[ "$suite" == all || "$suite" == engine ]]; then log "engine (offline)"; (cd "$BACKEND" && offline_test engine 'apps/engine/src/**/*.spec.ts') || rc=1; fi
    if [[ "$suite" == all || "$suite" == shared ]]; then log "shared (offline)"; (cd "$BACKEND" && offline_test shared 'packages/shared/src/**/*.spec.ts') || rc=1; fi
    date -u +%FT%TZ > "$RUN/tests/last-run.txt"; return $rc
  fi
  if [[ "$suite" == all || "$suite" == api ]]; then
    log "API jest"; (cd "$BACKEND" && envload && pnpm --filter api exec jest --runInBand 2>&1 | tee "$RUN/tests/api.log"; exit "${PIPESTATUS[0]}") || rc=1
  fi
  if [[ "$suite" == all || "$suite" == engine ]]; then
    log "engine node --test"; (cd "$BACKEND" && envload && pnpm --filter engine test 2>&1 | tee "$RUN/tests/engine.log"; exit "${PIPESTATUS[0]}") || rc=1
  fi
  if [[ "$suite" == all || "$suite" == shared ]]; then
    log "shared node --test"; (cd "$BACKEND" && envload && TS_NODE_PROJECT=packages/shared/tsconfig.json node --test -r ./apps/api/node_modules/ts-node/register 'packages/shared/src/**/*.spec.ts' 2>&1 | tee "$RUN/tests/shared.log"; exit "${PIPESTATUS[0]}") || rc=1
  fi
  if [[ "$suite" == all || "$suite" == admin-regression ]]; then
    if [ -f "$ADMIN/tests/npc-risk-regression.test.cjs" ]; then
      log "admin regression"; (cd "$ADMIN" && node --test tests/npc-risk-regression.test.cjs 2>&1 | tee "$RUN/tests/admin-regression.log"; exit "${PIPESTATUS[0]}") || rc=1
    fi
  fi
  date -u +%FT%TZ > "$RUN/tests/last-run.txt"; return $rc
}

cmd_probe() { (cd "$WB_ROOT" && envload && node "$TOOLS/probe.mjs" "$@"); }
cmd_ports() {
  cat <<EOF
Trading app : http://127.0.0.1:$FRONTEND_PORT
Admin       : http://127.0.0.1:$ADMIN_PORT
API         : http://127.0.0.1:$API_PORT   (Swagger: /docs)
Postgres    : $DATABASE_URL
Redis       : $REDIS_URL
Logins      : see $ENVDIR/backend.env (SEED_ADMIN_*, SEED_DEMO_*)
EOF
}
cmd_setup() { cmd_prereqs && cmd_env && cmd_install && cmd_generate && cmd_db_migrate && cmd_db_seed && cmd_build all && cmd_start && cmd_status && cmd_ports; }

case "${1:-help}" in
  setup) cmd_setup;; prereqs) cmd_prereqs;; env) cmd_env;; install) cmd_install;; generate) cmd_generate;;
  db:migrate) cmd_db_migrate;; db:seed) cmd_db_seed;; db:reset) cmd_db_reset;;
  build) cmd_build "${2:-all}";; start) shift; cmd_start "$@";; stop) shift; cmd_stop "$@";; restart) shift; cmd_restart "$@";;
  status) cmd_status;; logs) cmd_logs "${2:-}" "${3:-80}";; test) cmd_test "${2:-all}";; probe) shift; cmd_probe "$@";; ports) cmd_ports;;
  *) sed -n '2,24p' "$0";;
esac
