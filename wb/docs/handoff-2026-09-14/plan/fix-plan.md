# TickTrade stabilisation plan — contracts and per-agent scope

Repos (separate git repos, all on their working branches, never push):
- backend: /home/claude/wb/backend (pnpm monorepo, NestJS 11, Prisma 5.22, Redis). SOURCE FILES ARE CRLF. Read with `tr -d '\r'`; when you edit with the Edit tool the matched text keeps CRLF automatically only if your old/new strings match the file bytes — prefer python/`sed` or the helper `/tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/patchlib.py` (`from patchlib import patch, write_new` — `patch(path, [(old, new[, count])])` normalises line endings for you; `write_new(path, text, crlf=True)` for new files). Verify with `file <path>` that you did not convert a CRLF file to LF.
- frontend (trading PWA): /home/claude/wb/frontend (React 19 + Vite, lightweight-charts 5.1, socket.io-client 4.8, zustand). LF files.
- admin: /home/claude/wb/admin (React + Vite). LF files.

Running workbench (already up): API http://127.0.0.1:18773, PWA http://127.0.0.1:18771, admin http://127.0.0.1:18772, Postgres/Redis local. Env in /home/claude/wb/env/backend.env (SEED_DEMO_EMAIL/PASSWORD for the PWA demo user, SEED_ADMIN_* for admin). Restart backend after backend edits with `bash /home/user/claude-code-ai/tools/restart-backend.sh` (builds are NOT included — build first). `wb status` shows service health.

Builds / checks:
- backend shared: `cd /home/claude/wb/backend && pnpm --filter @ticktrade/shared build` (apps resolve @ticktrade/shared from packages/shared/dist, so rebuild shared after changing it).
- backend api (also builds the engine-worker/settlement-worker entries): `pnpm --filter api build`; engine: `pnpm --filter engine build` (check package names with `cat apps/*/package.json | grep '"name"'`). Type-check only: `npx tsc --noEmit -p apps/<app>/tsconfig.json`.
- tests: `cd packages/shared && pnpm test` (baseline 232/235 — 3 pre-existing `last-moment-company-hedge` failures), `cd apps/engine && pnpm test` (baseline 85/97 — 12 pre-existing pricing/npc-simulator.protection failures). Do not make these worse; add node --test specs next to the code you change.
- frontend: `cd /home/claude/wb/frontend && npx vite build` and `npx eslint src/<files you touched>`.
- admin: `cd /home/claude/wb/admin && npx vite build` and eslint on touched files.

Audit findings (read the one for your area BEFORE coding; they carry exact file:line evidence):
/tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/audit-<area>.md for areas: chart-data, chart-motion, timer-progress-pnl, engine-perf, api-ws-perf, legacy-npc, pwa-shell-perf.

Global rules for every agent:
1. This is a finance app. Never change money math unless the plan says so; when you touch a money path, add a regression test.
2. Keep behaviour changes minimal and explicit; do not refactor for style. Every new env flag must have a safe default and be listed in your report.
3. Do not touch files outside your ownership list (below). If you need a change in another agent's file, write it in your report under "requests for other agents" with exact code.
4. No model identifiers in code/comments. No secrets. Do not commit or push; the orchestrator commits.
5. Report: return a structured summary (schema given by the workflow) listing every file changed, what changed and why, how to test, new settings/env, and anything you could not finish.

======================================================================
CROSS-AGENT CONTRACTS (pinned — implement exactly)
======================================================================

## C1. Chart stream is ONE continuous wall-clock series (server canonical)
- Backend line-chart gateway keeps a single continuous 1-second candle stream for the `all` scope that spans battles AND the cooldown/idle seconds between them. Every second exactly one candle closes (flat candle when there was no trade: o=h=l=c=last known close, volume 0, count 0). This stream is what clients render. Per-battle keys may stay for admin/history but are not the client contract.
- `candleClosed` (room `line_chart_all`) is emitted EVERY second, including flat candles and cooldown seconds. Payload (UnifiedCandlePayload): `{ timestamp (bucket start, epoch SECONDS), o,h,l,c, volume ($ notional traded in that second, real+NPC), count (trades), battle_id (number | null when no battle was active in that second), server_time (epoch ms, the server clock when the candle was emitted) }`. Client-side dedupe key becomes `timestamp` alone (single stream).
- `candleBatch` (sent on /line-chart connection and on `subscribe`): `{ candles: UnifiedCandlePayload[] ascending, contiguous 1/s, the last WINDOW_SECONDS=600 seconds of the `all` stream (flat candles included) plus the in-progress bucket as the last element (flag `partial: true`), active_battle_id, included_battle_ids (the distinct non-null battle_ids actually present in `candles`), window_seconds: 600, server_time (ms), replace: true }`. Memoised per second (same payload for every socket that connects within the same second). Server must NOT send two batches per connect (either emit on connection or on `subscribe`, not both — choose: emit on connection AND on explicit `subscribe` only when the socket asks with `{ reason: 'resync' }`; the client stops emitting `subscribe` on connect).
- Client: on `candleBatch` with `replace: true`, REPLACE the lineChartStore candle array with the batch (drop everything local), then continue appending live `candleClosed`/`priceUpdate`. No sessionStorage candle mirrors, no resume-snapshot candles, no per-battle reset of the chart store at battleEnd/newBattleStarted. Store cap 900 candles (15 min).
- `priceUpdate` (main namespace, room `battle_<id>`, ≤5/s) gains two fields: `bucket_ts` (epoch seconds of the in-progress candle) and `volume` ($ notional accumulated in that bucket so far). Existing fields unchanged. Client uses it only to move the in-progress bar (value + volume); it never creates history.
- Price ticks from the engine: `engine:events:price.tick.volumeScale` = SUM of trade notional of all trades since the previous PUBLISHED tick for that battle (the 200 ms coalescer accumulates instead of dropping), and the coalescer flushes a trailing tick at the end of a window so the last price of a burst is always published. API dedupe key for price ticks uses `eventId` (falls back to battle+ms+price only if eventId is missing).

## C2. Timer
- `timerUpdate` payload unchanged (`time_remaining, time_elapsed, total_duration, timestamp ms, battle_id, is_finalize...`). Server additionally emits one `timerUpdate` to the socket at the end of `subscribeToBattle` (from Redis battle meta `startTimeMs + durationSeconds`, so reconnect/foreground re-anchors immediately).
- Client keeps a local 1 Hz countdown anchored to the last server frame (`anchorRemaining`, `anchorReceivedAt`); server frames re-anchor (snap when |delta| ≥ 1 s). Timer ticks are accepted when the client has no battle id yet (adopt battle_id).

## C3. NPC status API (admin ⇄ backend)
- `GET /admin/npc/simulator/status` returns, in addition to today's fields: `desired_active_source: 'redis' | 'db' | 'default'`, `recent_trades: Array<{ at: ISO string, battle_id, npc_id, username, side: 'BUY'|'SELL', amount, source: 'legacy'|'organic', reason?: string }>` (last 50, newest first) read from Redis list `ticktrade:npc:recent_trades` (LPUSH + LTRIM 0 49 by the worker on every NPC fill, JSON per entry).
- NPC ON/OFF durable: system_settings key `npc_simulator_active` ('1'/'0') written by start/stop; Redis key remains the hot mirror; MISSING Redis key now means: read DB row; if no row → OFF (not ON). Worker mirrors the resolved value back to Redis on boot/poll.
- Engine mode: when the worker/engine falls back to the DB for `npc_engine_mode`/organic doc it writes the value back to Redis; the API reader (`readNpcEngineModeFromRedis`) accepts an optional DB fallback getter and the trades service uses it.
- Rotation settings gain two keys (DTO + parse + admin UI): `npc_rotation_starvation_policy: 'relax' | 'pause'` (default 'relax' = today's fallback behaviour, but the fallback is logged once per minute and surfaced in status as `rotation_starved: boolean`), `npc_rotation_timezone_offset_minutes` (default 0 = UTC; window evaluated with it). Rotation "participation session" = (npcId, battleId): caps/cooldown commit ONCE per NPC per round (first landed fill), not per trade.

## C4. Admin organic tab
- Keeps the existing REST contract (GET /admin/npc/organic/schema, GET/PUT /settings, /mode, /status, /live, /rounds, /settings/reset). Pencil edit = PUT the full values document with the one changed field (immediate save, like Battle Settings).

======================================================================
AGENT SCOPES (file ownership) — wave 1 runs these in parallel
======================================================================

### A. chart-api  (backend, chart pipeline)
Owns: apps/api/src/ws/line-chart.gateway.ts, apps/api/src/chart/*, and in apps/api/src/redis/redis.subscriber.ts ONLY the price-tick section (handlePriceTick / priceUpdate coalescer / dedupe) — re-read the file before each edit, keep edits local; another agent edits other regions of the same file concurrently.
Do:
- C1 server side: continuous `all` stream with flat candles every second including between battles (the boundary closer must run always, not only while a battle is active; verify what drives it today); persist `all` history in Redis (zset by timestamp, trim to 900), candleBatch = last 600 + partial; `included_battle_ids` reflects reality; memoise batch per second; emit-on-connect only (subscribe with reason 'resync' re-sends); `server_time` ms on candleClosed and candleBatch; `battle_id` null for idle seconds.
- Keep per-battle history and the completed archive for admin tooling, but add TTL 7 days to `chart:history:completed:*` and 24 h to per-battle live keys after the battle ends (audit F10).
- Volume: DB rebuild path uses `price_ticks.tradeAmount` (real $ notional) not tick count (F4); API dedupe by eventId (F3).
- priceUpdate: add `bucket_ts` + `volume` from the live `all` candle (expose a cheap getter on the gateway).
- MAX_POINTS: make per-battle trim ≥ 400 and the `all` trim 900 (F5).
- Add a node --test spec for candle-aggregation (flat fill, volume accumulation, batch window) if practical.

### B. chart-pwa  (frontend chart)
Owns: src/components/NewChart.jsx, src/stores/lineChartStore.js, src/live/utils/chartNormalization.js, src/live/services/chart*.js, finalBattleSnapshotService.js (candles part), battleEndTransitionService.js / battleNewBattleStartedTransitionService.js / battleSnapshotTransitionService.js (only the chart reset calls), src/utils/persistCandleClosedSession.js (delete), src/utils/hydrateMatchFromResume.js (drop candle hydration), src/screens/Matches.jsx (drop candle re-hydration), src/components/ResumeSyncBridge.jsx ONLY the recentCandles/chart subscriber (remove it), src/index.css chart rules, and in src/utils/useWebSocket.js ONLY the line-chart handlers (onCandleBatch, onCandleClosed, onLineChartConnect, resubscribeLineChart/forceLineChartSync, the priceUpdate→chart forwarding block) — another agent edits other regions of useWebSocket.js later; keep your edits local and do not reformat.
Do (see audit chart-motion + chart-data + pwa-shell F1/F4/F7):
- C1 client side: store = one continuous array (cap 900), replace on candleBatch, append candleClosed (dedupe by timestamp), in-progress bar from priceUpdate (value + volume + bucket_ts). No reset at battleEnd/newBattleStarted (only entry line / battle id refs change). Remove sessionStorage mirror + resume candles + finalBattleSnapshot candles.
- Time axis = 1 bar per second (flat candles included) so the x-axis is wall-clock across rounds and cooldown. Visible window fixed: `timeScale().applyOptions({ barSpacing: plotWidth/80, rightOffset: 18 })`, never `setVisibleRange` over N bars, never re-zoom at round boundaries; `setData` only on batch replace, `update` for appends.
- Time cursor (`.chart-expiry-line`): x = `timeScale().timeToCoordinate(lastBarTime) + frac * liveBarSpacing`, `liveBarSpacing` measured from `logicalToCoordinate(i+1) - logicalToCoordinate(i)` (never `options().barSpacing`), `frac = clamp((serverNow - lastBarTime*1000)/1000, 0, 1.25)` with `serverNow = Date.now() + serverOffsetMs` (offset = EMA of `server_time - Date.now()` from candleClosed). Always mounted; visibility via a class; no per-frame layout reads (cache plot offsets on resize/reseat). Result: it stays where the round ended and glides right through cooldown.
- ROUND ENTRY always visible: `autoscaleInfoProvider` on the AreaSeries that widens the range to include `entryPriceRef.current`; remove the manual price-scale mode toggling; price scale autoscale always on.
- Volume histogram: `autoscaleInfoProvider` = 0..max(volume over the WHOLE loaded series) (not the visible window) so bar heights are comparable and identical on every device.
- Closed bars carry the exact server close (write `series.update({time, value: close})` on candleClosed before advancing); ease only the in-progress bar; RAF loop stops when converged (restart from tick/candle callbacks); `series.update` only when the value changed; glow ≤ 30 fps; on visibilitychange→visible re-apply the store to the series.
- Narrow the matchStore selector in NewChart to the scalars it needs (pwa F10).
- Remove the dead `chartStreamService.register` path or wire it (chart-motion F8).
- Keep the entry-line label + expiry tag styling; keep existing class names used by tests/tools (`.chart-expiry-line`, `.chart-expiry-tag`, `.chart-round-entry-label`).

### C. pwa-panel  (frontend timer, pool bar, estimator, shell perf)
Owns: src/hooks/useBattleCountdown.js, src/stores/matchStore.js (timer part), src/components/TradingPanel.jsx + TradingPanel.css, src/components/WinEstimatorSheet.jsx, src/live/hooks/useMarketFlip.js, src/live/hooks/useWinEstimate.js, src/live/utils/realtimeEventGuards.js, src/components/ResumeSyncBridge.jsx (everything except the chart subscriber), src/stores/appResumeStore.js, src/live/telemetry/realtimeTelemetry.js, src/components/PriceBadge.jsx, src/live/services/socketHealthService.js, src/stores/authStore.js + src/utils/clearStorageOnLoginRedirect.js (clear resume snapshot on logout), vite.config.js, src/live/services/timerCooldownTransitionService.js. DO NOT edit src/utils/useWebSocket.js in this wave (write needed changes into your report; a follow-up agent applies them).
Do (audit timer-progress-pnl T1,T9,T10,E1,E2(client),E3,B1,P1,P2,P3; pwa-shell F3,F5,F8,F9,F10):
- C2 client: local ticking countdown anchored to server frames; accept ticks when battle id unknown; tolerate ≤2 s backwards skew for timerUpdate.
- Pool bar labels rendered as absolutely positioned children of the track (above the dot, never clipped), fills stay clamped; both numbers always fully visible.
- Market Flip: requestId per dispatch (not per effect run), leading+trailing throttle 750 ms, fire immediately on side-sign change, quantise potSignature to 0.5 % of total pot, VERDICT_DAMP_MS 300; same requestId fix + ≤1 req/s throttle for useWinEstimate. Do NOT redesign the panel (a new arena order design comes later); only make the losing state appear promptly and consistently.
- Perf: pool-bar RAF stops when converged; telemetry frame monitor DEV-only; ResumeSyncBridge persists through the 750 ms throttle and never on price ticks; resume snapshot cleared on logout and ignored for a different user id; stale watchdog threshold 12 s with 0–4 s jitter and cheap ping before reconnect; PriceBadge selects a scalar; vite: CacheFirst for hashed /assets, precache arena chunks, move `pure/drop` to top-level `esbuild`.

### D. engine  (backend engine process)
Owns: apps/engine/src/** (all), packages/shared/src/redis/battle-leaderboard.ts, packages/shared/src/events/* EXCEPT npc-simulator.redis.ts, packages/shared/src/npc-organic/round-context.ts. NOT apps/engine/src/npc/** and NOT apps/engine/src/npc-organic/** (owned by agent E).
Do (audit engine-perf F1–F13, chart-data F3, and the continuity bug):
- F1: serialise trade.executed handling per battle (FIFO promise chain) so market state is never lost; add a spec.
- F2/F3: finishBattle must not stop the heartbeat before battle.end + settlement enqueue succeeded; bounded retry; engine-side settlement watchdog (poll battle status after enqueue; if COMPLETED without event → schedule next round; if FAILED job → job.retry()/fresh jobId); healPendingSettlements retries failed jobs; idle watchdog that recovers when no battle and no pending creation for > cooldown+15 s.
- Continuity price: `resolveBattleContinuityPrice` falls back to the last COMPLETED battle's endPrice from Postgres before spawning a fresh 1.23 price (the restart cliff we reproduced: battle 79 ended 1.28337, battle 80 spawned 1.23677).
- F4: risk-terminal tick cost: cache rpcUser ids 60 s; bound price-tick reads (aggregate high/low/last, not findMany of all rows); compute at 1 Hz only while an admin is watching (API sets Redis key `ticktrade:risk-terminal:watchers` with TTL 15 s while room `admin_risk_terminal` is non-empty — agent F adds that; you read it) else every 5 s; publish only when inputs changed.
- F5: distinct trader count via a per-battle SET (SADD where the leaderboard zsets are written) or ZUNIONSTORE+ZCARD server-side; never ZRANGE 0 -1 on the hot path.
- F6: dedicated ioredis connection for timer publishes; `.catch` on every fire-and-forget publish; `process.on('unhandledRejection')` that logs; heartbeat aligned to the second boundary via self-rescheduling setTimeout; skip duplicate `remaining` values.
- F7: leadership not dropped on a transient Redis error until TTL provably elapsed; startEngine keeps existing market state (only creates when missing); start/stop runtime mutually exclusive.
- F8: candle bucket timer in-flight guard; F11: TTL 24 h on market:state / active:candle keys and cleanup after settlement.
- C1: price-tick coalescer accumulates volumeScale and flushes a trailing tick; heartbeat re-publishes the current price once per second when it differs from the last published (source 'heartbeat').
- Keep `TIMER_HEARTBEAT` payload shape unchanged.

### E. npc  (backend legacy NPC + organic engine glue + admin NPC services)
Owns: apps/engine/src/npc/**, apps/engine/src/npc-organic/**, apps/npc-worker/src/**, packages/shared/src/npc/**, packages/shared/src/events/npc-simulator.redis.ts, packages/shared/src/npc-organic/engine-mode.redis.ts and settings.ts (copy/tags only), apps/api/src/admin/npc/** (admin-npc*.service.ts, controllers, DTOs), apps/api/src/admin/admin.service.ts (npc-behavior section only), apps/api/src/trades/trades.service.ts ONLY the engine-mode read call sites (lines ~1457 and ~2871 — another agent edits other regions concurrently; minimal local edits).
Do (audit legacy-npc BUG-1..BUG-12, INV-5 dead key, INV-8 tags):
- C3 backend side (durable ON/OFF with DB fallback and default OFF; mode mirror-back; status source; recent-trades ring; rotation starvation policy + timezone offset; session-per-round rotation commit).
- BUG-3/4/6: ONE selection gate `pickEligibleNpc(battleId, side, opts)` used by simulateTick, liquidity heartbeat, intelligence runner, reactive bursts and defense paths (defense paths may pass `bypassCaps: true` but must still stamp participation); LRU uses real last-participation timestamps; round_robin uses the Redis cursor over the full roster; `rotationPaused` respected everywhere; organic engine filters tier buckets by eligibility instead of dropping arrivals and applies the allowed window.
- BUG-5: `npc_force_win_enable` row is authoritative when present.
- BUG-8 fixes need admin UI (agent G) — backend: clamp aggression to [0.3, 3] in the DTO and return the effective value.
- BUG-11 (asymmetry plan keyed by stats.battleId), BUG-12 (timezone offset), INV-5 (`npc_volume_target_amount_nudge_max`: implement as documented — nudge the target amount by up to ±max fraction — or remove it from DTO/UI; choose implement), INV-8 (`defenses.finalInjectionLeadMs` re-armed on change; fix help text; hide `engine.mode` from the doc form via schema flag `hidden: true`).
- NPC trade publish coalescer accumulates fills into an array instead of overwriting (so aggregates published to the PWA are complete).
- Add node --test specs for: default-OFF resolution, session-per-round commit, pickEligibleNpc gating, force-win row precedence.

### F. api-core  (backend API stability, trade path, WS fan-out, timer relay)
Owns: apps/api/src/main.ts, apps/api/src/ws/** EXCEPT line-chart.gateway.ts, apps/api/src/redis/** EXCEPT the price-tick section of redis.subscriber.ts (agent A edits that region concurrently — re-read before every edit, keep edits local), apps/api/src/trades/** (except the two engine-mode call sites agent E touches), apps/api/src/battle/**, apps/api/src/engine-worker/**, apps/api/src/settlement-worker entry if any, packages/shared/src/payout/** (only for the shared projection memo), apps/api/src/admin/risk-terminal* (watchers key).
Do (audit api-ws-perf F1–F17, timer-progress-pnl T2,T3,E2(server),E3(server); pwa-shell F2 server side):
- F1/F2/F3 money bugs: atomic pending-debit drain (Lua HGETALL+DEL or RENAME to a per-flush key; on Postgres failure add the amounts back), negative pending values applied as increments (never clamped away), dirty-set drained with SPOP; write the stake buffer row and the pending debit atomically (MULTI) or stake first then debit with reconciliation. Add specs with a redis mock.
- F4: coalescer dedupes by idempotencyKey (same key → attach waiter, no amount added); F5: worker checks `results.get(commandId)` first and BullMQ Worker gets `lockDuration ≥ tx timeout`, `maxStalledCount: 0`.
- F6: `.catch` on every `void` promise; `process.on('unhandledRejection')` in main.ts + worker mains (log, keep alive).
- F7 + pwa F2: subscribeToBattle dedupes the WHOLE pipeline per socket within 3 s, accepts `range` in the base payload (so the client sends one emit), removes the duplicate dashboard emit, in-memory cache of active battle id / bootstrap snapshot / chat history / top traders per battle (invalidate on battle events), rate-limit bucket for subscribeToBattle and chatHistory; `broadcast_to_all` restricted to ADMIN. C2: emit `timerUpdate` at the end of subscribeToBattle.
- F8/T2: one shared battleSnapshot emit per room + per-user `free_taps_left` only when it changes; top-traders decoupled from the snapshot flush (respect throttle); dashboards on trade events and ≥1 s; `emitActiveTradeStreamUpdatesForBattle` off the timer tick (own 1 s guarded interval); shared per-battle projection memo (battleId|priceBucket|potSig, TTL 750 ms) used by dashboard, trade stream, balance snapshot, market-flip and estimate; bound `priceTick.findMany` (downsample or per-battle in-memory ring).
- F12/T3: emit `battleEnd` immediately (pacer drains in background); when the broadcaster lease is lost on a single-instance deployment keep forwarding (env `WS_SINGLE_INSTANCE`, default true) and log; replace per-call setTimeout yields with one flush timer.
- F9: env `WS_REDIS_ADAPTER` default stays but add `WS_LOCAL_EMIT=true` default → emits use `server.local` when the adapter is on and single instance; document.
- F13 (map keys), F14 (cleanup on battle end/disconnect), F15 (TradesService emits via WS_EMIT_PORT so worker-side emits reach sockets), F16 (pingInterval 15 s / pingTimeout 25 s), F17 (auth verdict cached 5 s per socket; single Lua for rate limit).
- E2 server: dashboard uses `resolveLiveCurrentPrice` (Redis last price) not the DB tail; E3 server: estimate endpoint served from the shared memo.
- Risk terminal watchers key: when room `admin_risk_terminal` gains a member set Redis `ticktrade:risk-terminal:watchers`=1 EX 15 and refresh every 5 s while non-empty.

### G. admin-ui  (admin React app)
Owns: /home/claude/wb/admin/src/Pages/AdminDashboard/NpcOrganicEngine.jsx (rewrite), npcOrganicApi.js, npcSimulator.jsx (Behavior tab, NPC Traders status/recent trades, Rotation tab new fields), NpcSimulator.css, new files under that folder.
Do (audit legacy-npc UI-1, UI-2, BUG-8, BUG-9, C3, C4):
- Rebuild the Organic Engine tab in the Battle Settings / Market Sensitivity design language: sticky compact live strip at the top (mode pill, engine RUNNING/STOPPED, round #, heartbeat, saved vN / applied vN); a left section nav (Engine, Round start, Momentum, Tiers, Asymmetry, Defenses, Audit) that scrolls to `.battle-details-card` sections; each field = `.battle-detail-item` row (label, formatted value + unit, applies badge `live`/`next round`, pencil button → `.modal-card` editor with help text, min/max/default, validation) that saves immediately via PUT of the full doc; an info stripe (`.rotation-info-box`) under each row with plain-language help; computed previews per section (arrivals/min curve summary, tier stake ranges, expected initial wave window, peak-hours "peak now: yes/no"); a MarketSensitivity-style Live Preview card for the live round (• LIVE pill, stat boxes, pot bar, recent NPC trades `.admin-table`); Round audits kept. Booleans as toggles that save immediately. Keep the "Switch to legacy/organic" control with confirm.
- NPC Behavior tab: default 'normal', aggression max 3 step 0.1 with the clamp note, copy rewritten to "scales stake sizes and defense caps (0.3–3×), does not change timing".
- NPC Traders tab: status from worker heartbeat + `desired_active_source`; recent trades list fed by `recent_trades` from the status endpoint (poll 5 s while the tab is open).
- Rotation & Limits: add "Starvation policy" (relax / pause) radio and "Timezone offset (minutes)" input with info boxes; show a warning card when status reports `rotation_starved`.
- Use the existing tokens (cyan #00d6de accent, pink #ff2d86, `.battle-details-card`, `.battle-detail-item`, `.edit-icon-btn`, `.rotation-info-box`, `.modal-card`, `.um-status-badge`). Must work at 1280 px and 390 px widths.
- Verify with `npx vite build` and a Playwright screenshot: `node /home/user/claude-code-ai/tools/admin-shot.cjs "User Management|NPC Simulator|ORGANIC ENGINE"` (writes /home/claude/wb/run/smoke/admin-organic-engine.png) — look at it.

======================================================================
WAVE 2 (after wave 1): pwa-shell agent applies the useWebSocket.js changes requested by agents B/C/F: single foreground sync path (drop the duplicate listener), syncNow dedupe even when forced (1 s), one subscribeToBattle emit carrying `range`, remove `subscribeToPrice`, reconnect handlers on `socket.io` (manager), remove dead marketSnapshot/delta branches, timer T10 adoption, no client `subscribe` on line-chart connect (server emits on connection), `subscribe {reason:'resync'}` on foreground/stale. Then an integration agent builds everything, restarts the stack, runs the smokes (tools/chart-parity-capture.cjs, tools/round-boundary-shots.cjs, tools/admin-tools-smoke.cjs) and fixes compile/runtime errors in any file.

======================================================================
WAVE-1 OPERATING RULES (concurrency)
======================================================================
- Seven agents edit the three repos at the same time. Do NOT restart the backend/frontend/admin services in wave 1 (the integration agent does that); do not run `git checkout`/`git stash`/`git clean` in any repo.
- Prefer `npx tsc --noEmit -p apps/<app>/tsconfig.json` (backend) for type checks; run a full `pnpm --filter <pkg> build` only once at the end of your work. Rebuild shared (`pnpm --filter @ticktrade/shared build`) right after you change packages/shared so other agents see your exports.
- Another agent may have changed a file you own since you last read it only if it is listed as shared above (redis.subscriber.ts, useWebSocket.js, trades.service.ts); re-read before editing those. If the Edit tool reports the file changed, re-read and retry.
- Runtime verification against the running stack is allowed only READ-ONLY (curl, socket clients, screenshots) — the stack still runs the OLD build until the integration agent restarts it, so do not draw conclusions about your change from it.
