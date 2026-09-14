#!/usr/bin/env bash
# Usage: impact-test.sh "sell 100000" "buy 100000" ...   (NPC simulator should be stopped for a clean read)
set -u
API=http://127.0.0.1:18773
source <(grep -E "^(DATABASE_URL|SEED_DEMO_EMAIL|SEED_DEMO_PASSWORD)=" /home/claude/wb/env/backend.env)
D=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$SEED_DEMO_EMAIL\",\"password\":\"$SEED_DEMO_PASSWORD\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('access_token') or d.get('token') or '')")
for i in $(seq 1 60); do
  BID=$(psql "$DATABASE_URL" -tAc "select id from battles where status='ACTIVE' and state='OPEN' order by id desc limit 1")
  if [ -n "$BID" ]; then
    REM=$(psql "$DATABASE_URL" -tAc "select round(extract(epoch from (\"startTime\" + (\"durationSeconds\"||' seconds')::interval - now()))) from battles where id=$BID")
    if [ "$REM" -gt $(( ${#@} * 4 + 20 )) ]; then break; fi
  fi
  sleep 5
done
echo "battle=$BID remaining=${REM}s startPrice=$(psql "$DATABASE_URL" -tAc "select \"startPrice\" from battles where id=$BID")"
for T in "$@"; do
  set -- $T
  P0=$(redis-cli get ticktrade:price:last)
  R=$(curl -s -X POST $API/trades/$1 -H "Authorization: Bearer $D" -H 'Content-Type: application/json' -d "{\"battle_id\":$BID,\"amount\":$2}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status') or d.get('error') or d.get('message'))")
  sleep 2
  P1=$(redis-cli get ticktrade:price:last)
  python3 -c "p0=float('$P0');p1=float('$P1');print('%-5s %8s: before %s after %s  move = %+.4f pips  [%s]' % ('$1','$2',p0,p1,(p1-p0)/0.0001,'$R'))"
done
