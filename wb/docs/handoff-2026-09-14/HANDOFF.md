# TickTrade stabilisation — handoff for the next engineering session

Date: 2026-09-14 (18:50 UTC). This bundle stops a stabilisation effort mid-way so it can be continued from another account. Read this file first; it tells you what the client asked for, what is finished, what is half-finished, what has not started, and the exact order in which to continue.

## 0. The client's request (verbatim intent, five points)

1. **Chart**: sudden vertical spikes (especially after signing in on a phone); phone and web charts are not identical and must be identical on PC, phone and tablet; the volume bars look wrong (a $100k order raised the bar, a later ~$10k order gave the same or a higher bar).
2. **Motion**: when a battle ends the vertical time line jumps far LEFT and only moves right when the next match starts. It must stay where the match ended and move right as time passes; strange chart motion between round and cooldown when a new match enters; make the time line smoother; the pool progress bar hides the smaller pool's number when one side is huge; the profit estimator takes seconds to realise the user is losing and to show the flip data (a new arena order design will come later; for now fix the delay).
3. **ROUND ENTRY line** must always stay visible (the chart should rescale to keep it in view).
4. **Legacy ("developer") NPC**: keep its settings, make its logic correct and link it to the PWA; redesign the Organic Engine admin tab in the style of the developer's tool pages (Battle Settings / Market Sensitivity) so settings are easier to understand and faster to control.
5. **Timer** freezes / gets stuck under heavy load, delayed updates, general instability. Dig deep in frontend and backend, find and fix every bug, slow path and delay so the foundations are clean before new tools are added.

Deliverable the client expects at the end: the latest ZIPs (backend, admin, frontend) **plus one very detailed PDF** explaining exactly what changed and how to test it, for their dev team ("finance app, no errors can be inside").

## 1. What is in this bundle

| File | What it is |
|---|---|
| `ASPR-backend--dev-stabilisation-wip-2026-09-14.zip` | Backend repo at the WIP commit (git archive of HEAD, no node_modules). |
| `Tick-Trade-project-APSR-dev-stabilisation-wip-2026-09-14.zip` | Trading PWA at the WIP commit. |
| `APSR-admin--dev-stabilisation-wip-2026-09-14.zip` | Admin app at the WIP commit (admin has **no changes yet** in this effort; it equals the last delivered drop). |
| `patches/<repo>/*.patch` | Every commit of the whole engagement as git patches (numbered). The last patch per repo is this WIP commit. |
| `workbench-tooling.zip` | The workbench (`wb/`) that runs the whole stack locally: bootstrap, `wb` CLI, restart script, Playwright smokes and capture tools, change log, previous engineering reports. |
| `plan/fix-plan.md` | **The specification** the implementation followed: pinned cross-agent contracts (C1 chart stream, C2 timer, C3 NPC status API, C4 admin organic tab) and per-area scopes A–G. Continue against it. |
| `plan/audit-*.md` (7 files) | The root-cause audit with file:line evidence for every finding (chart-data, chart-motion, timer-progress-pnl, engine-perf, api-ws-perf, legacy-npc, pwa-shell-perf). |
| `plan/report-ch2-findings.md` | Chapter 2 ("What we found") of the final PDF, already written (~7,300 words). Reuse it verbatim. |
| `plan/reports/*.json` | The structured completion reports of the four finished areas (files changed, behaviour changes, tests, verification, `notes_for_pdf` = ready-to-use PDF text, and requests for other areas). |
| `plan/workflow-implement.js`, `plan/workflow-review.js` | The orchestration scripts used (implement wave with file ownership; adversarial review with 6 lenses × 3 verifiers × per-repo fixers). Reusable as prompts even without the Workflow tool. |
| `plan/previous-report/TickTrade-Engineering-Report-2026-09-14.md` | The report delivered for the earlier drops (organic NPC engine, market sensitivity, admin risk tools). The new PDF continues its numbering/style. |

Not included: `env/backend.env` (local secrets). Recreate it from `wb/README.md` / `bootstrap.sh` (`DATABASE_URL`, `REDIS_URL`, `SEED_ADMIN_EMAIL/PASSWORD`, `SEED_DEMO_EMAIL/PASSWORD`, ports API 18773 / PWA 18771 / admin 18772).

## 2. State of the code (the WIP commits)

| Repo | Type-check / build | Tests |
|---|---|---|
| backend `packages/shared` | builds | 266 pass / 3 fail (the 3 are pre-existing `last-moment-company-hedge` failures; +34 new tests pass) |
| backend `apps/api` | `tsc --noEmit` clean, `pnpm --filter api build` clean | jest 78/78 (11 suites; +24 new) |
| backend `apps/engine` | `tsc --noEmit` clean (no build script; runs under ts-node) | 119 pass / 12 fail (the 12 are pre-existing pricing / npc-simulator.protection failures; +20 new pass) |
| backend `apps/npc-worker`, `apps/settlement-worker` | `tsc --noEmit` clean | — |
| frontend | `npx vite build` clean | `node --test "src/**/*.test.js"` 63/63 |
| admin | untouched | untouched |

**Nothing has been runtime-verified yet against a restarted stack.** All four finished areas were unit-tested only (wave-1 rule); the integration step (build, restart, smokes, screenshots) never ran. Treat the WIP commits as "compiles and unit-tests pass", not "verified".

Backend files are CRLF; keep them that way (the helper `plan/patchlib.py` normalises line endings when patching).

## 3. DONE (implemented + unit-tested, not yet integrated)

### A. Backend chart pipeline (contract C1 server side) — `plan/reports/A_chart-api*.json`
- `apps/api/src/ws/line-chart.gateway.ts` rewritten around ONE continuous wall-clock `all` stream: exactly one candle closes and is EMITTED every second, flat when idle, including cooldown seconds (`battle_id: null`). Stream restored from Redis zset `chart:history:all` (900 points, TTL 24 h) after a restart.
- `candleBatch` = last 600 seconds + in-progress bucket (`partial: true`), `replace: true`, real `included_battle_ids`, `server_time` ms; memoised per second; emitted on connection and on `subscribe {scope:'all', reason:'resync'}` (never two per connect). No batch broadcast on battle start any more.
- `priceUpdate` gains `bucket_ts` + `volume`; price-tick dedupe by `eventId`; late ticks fold into the open bucket; DB rebuild uses `price_ticks.tradeAmount`; per-battle keys trimmed at 400 with 24 h TTL, completed archive 7-day TTL.
- Tests: `apps/api/src/chart/candle-aggregation.spec.ts` (18), `apps/api/src/ws/line-chart.gateway.spec.ts` (6).

### B. PWA chart (contract C1 client side + all chart-motion findings) — `plan/reports/B_chart-pwa*.json`
- `lineChartStore` = one continuous array (cap 900), replaced on `candleBatch`, appended per second; no reset at battle end / new battle; sessionStorage candle mirror and resume candles removed (two files left as inert shims, see §5).
- `NewChart.jsx`: 1 bar per second wall-clock axis; fixed `barSpacing = plotWidth/80`, `rightOffset 18`, never re-zooms at boundaries; time cursor from time (`chartGeometryService.js`, `chartClockService.js` = server-offset EMA) — stays where the round ended and glides through cooldown; ROUND ENTRY included in autoscale via `autoscaleInfoProvider`; histogram scaled to the max of the whole loaded series; closed bars carry the exact server close; RAF loop stops when converged; narrowed store selectors.
- Tests: `lineChartStore.test.js` (12), `chartGeometryService.test.js` (8), `chartClockService.test.js` (4), `chartNormalization.test.js` (4).

### C. PWA timer / pool bar / estimator / shell perf — `plan/reports/C_pwa-panel*.json`
- Local 1 Hz countdown anchored to server frames (`timerCountdownAnchor.js`, `useBattleCountdown.js`, `matchStore.js`); 2 s skew tolerance and null-battle acceptance in `realtimeEventGuards.js`.
- Pool bar labels moved out of the clamped fills (`TradingPanel.jsx/.css`): both numbers always fully visible above the dot.
- Market Flip / estimate fetch loops: requestId per dispatch, leading+trailing throttle (`requestThrottle.js`), immediate fire on side change, pot signature quantised, verdict damper 300 ms.
- Perf/hygiene: pool-bar RAF stops when converged; telemetry frame monitor DEV-only; ResumeSyncBridge persists through the 750 ms throttle; resume snapshot cleared on logout and bound to the user id; stale watchdog 12 s floor + jitter + ping probe (`socketHealthService.js`); PriceBadge scalar selector; `vite.config.js` CacheFirst for hashed assets, arena chunks precached, console stripping effective.
- Tests: `timerCountdownAnchor.test.js` (11), `realtimeEventGuards.test.js` (7), `requestThrottle.test.js` (9), `socketHealthService.test.js` (8).

### D. Engine stability/perf — `plan/reports/D_engine*.json`
- Per-battle FIFO for `trade.executed` (`events/per-battle-serial-queue.ts`) — fixes the lost-update race on market state.
- `finishBattle`: update → battle.end → enqueue → stop, each step retried (`ENGINE_FINISH_IO_ATTEMPTS`, `ENGINE_FINISH_RETRY_MS`); settlement watchdog (`ENGINE_SETTLEMENT_WATCHDOG_MS`, retries FAILED jobs, schedules the next round if COMPLETED without event); idle watchdog (`ENGINE_IDLE_WATCHDOG_GRACE_MS`).
- Continuity price falls back to the last COMPLETED battle's `endPrice` from Postgres before spawning 1.23 (the reproduced restart cliff).
- Leader: transient Redis error keeps leadership until TTL elapsed; `startEngine` keeps existing market state; start/stop mutually exclusive.
- Dedicated Redis connection for timer publishes; `.catch` on fire-and-forget publishes; `process.on('unhandledRejection')`; heartbeat aligned to the second boundary (`ENGINE_HEARTBEAT_BOUNDARY_OFFSET_MS`), duplicate seconds skipped.
- Price-tick coalescer accumulates `volumeScale` and flushes a trailing tick (the $100k-volume regression has a test); heartbeat re-publishes the price once per second when it changed.
- Risk-terminal tick: rpc ids cached, incremental price-tick ring, recompute only on input change, 1 Hz only while an admin watches (`ticktrade:risk-terminal:watchers` key; `RISK_TERMINAL_IDLE_INTERVAL_MS` otherwise) — **the API side that writes the watchers key is not done (see §5)**.
- Trader count via one Lua ZUNIONSTORE+ZCARD (`countBattleLeaderboardUsers` in shared); candle bucket timer in-flight guard; 24 h TTL on `market:state` / `active:candle` keys.
- Tests: 20 new specs across `apps/engine/src/battle/*.spec.ts`, `events/*.spec.ts`, `packages/shared/src/redis/battle-leaderboard.spec.ts`, `npc-organic/round-context.spec.ts`; repaired `risk-terminal-regression.cjs` (10/10).

## 4. PARTIAL (in the WIP commit, interrupted twice by session limits — review before trusting)

### E. Legacy NPC + organic glue + admin NPC services (plan section E, contract C3)
Present in the tree (about 2,000 added lines): durable ON/OFF flag with DB fallback and default OFF (`packages/shared/src/events/npc-simulator.redis.ts`, `npc-simulator-active.spec.ts`), engine-mode mirror-back + DB fallback (`npc-organic/engine-mode.redis.ts` + spec), rotation session-per-round (`packages/shared/src/npc/npc-participation-session.ts` + spec), centralised selection gate (`packages/shared/src/npc/npc-selection-gate.ts` + spec), force-win row precedence (`apps/engine/src/npc/npc-force-win-precedence.spec.ts`), NPC trade coalescer accumulating fills (+ spec), recent-trades ring + status source in `admin-npc.service.ts`, rotation DTO/service with the two new keys, organic engine eligibility filtering, npc-worker wiring, `npc-startup-off.regression.cjs` updated to the new default.
Unknown/likely incomplete: whether ALL five producers (simulateTick, liquidity heartbeat, intelligence runner, reactive bursts, defense paths) go through the gate; LRU/round-robin fixes in `npc-rotation.ts`; `npc_volume_target_amount_nudge_max` implementation; `settings.ts` tags/hidden flag; asymmetry plan keying (BUG-11); timezone window (BUG-12). **Action: `git show HEAD -- <E files>` and check each item of plan section E against the diff.** No completion report exists for E.

### F. API core (plan section F: money bugs, idempotency, unhandled rejections, subscribe pipeline, fan-out, timer relay)
Present in the tree: `user-balance-flush.service.ts` (+192 lines: atomic drain), `user-spendable-balance.service.ts` (+108), `battle-stake-buffer.service.ts` (+31), `trades.service.ts` (+435: constituent idempotency keys stored, other changes), `packages/shared/src/payout/live-projection-memo.ts` + spec (shared projection memo), `battle-payout.live.ts` (+27).
Known gaps: the coalescer itself (`trade-order-coalescer.ts`) still forwards `idempotencyKey = null` when >1 keys were merged — only the meta field `idempotencyKeys` was added (by the orchestrator, to make the API compile); the derived batch key / same-key dedupe (F4) is NOT implemented. Everything else in section F (F5 worker idempotency + lockDuration, F6 `.catch`/unhandledRejection in main.ts and worker mains, F7 subscribe pipeline dedupe + `range` in payload + caches + rate limits + `timerUpdate` on subscribe (C2), F8/T2 shared snapshot emit + top-traders decoupling + trade-stream off the timer tick, F12/T3 battleEnd ordering + lease handling, F9 local emits, F13–F17, E2/E3 server side, risk-terminal watchers key, `ping` ack handler) must be checked against the diff — most of it is probably NOT there. No completion report exists for F.

Regression tests for the money paths (F1/F2/F3) — check whether `apps/api/src/trades/*.spec.ts` exist; jest currently reports 11 suites, so verify which of them cover the flush/rollback paths before trusting the change.

## 5. NOT STARTED

1. **G. Admin UI** (plan section G, contract C3/C4): Organic Engine tab redesign in the Battle Settings / Market Sensitivity language (row + pencil modal + info stripe, section nav, computed previews, live card), NPC Behavior tab fixes, NPC Traders status/recent trades, Rotation tab new fields. The admin repo is untouched. Design references: `wb/run/smoke/admin-battle-settings.png`, `admin-market-impact-sensitivity.png`, `admin-organic-engine.png` (in the tooling zip if present; otherwise regenerate with `tools/admin-shot.cjs`).
2. **Wave 2 pwa-shell** — edits to `frontend/src/utils/useWebSocket.js` requested by A/B/C (exact code in `plan/reports/*.json` → `requests_for_other_agents`): remove the sessionStorage-candle plumbing and dead backfill code (then delete `persistCandleClosedSession.js`, `chartHydrationService.js`, `battleLineChartResubscribeService.js`, `live/pipeline/chartPipeline.js`; also trim `battleResetService.js` / `storeDrivenBattleTransitionService.js`); T10 timer battle-id adoption; watchdog call-site values + `onAlive`; single foreground sync path (drop the focus/pageshow/visibilitychange listeners in useWebSocket, keep ResumeSyncBridge's) and dedupe forced `syncNow` (1 s); one `subscribeToBattle` emit carrying `range` (needs the F7 server change); remove `subscribeToPrice`; reconnect handlers on `socket.io` (manager); remove dead marketSnapshot/delta branches; no client `subscribe` on line-chart connect; `subscribe {reason:'resync'}` on foreground/stale. Also `frontend/eslint.config.js`: change `reactHooks.configs['recommended-latest']` to `reactHooks.configs.flat['recommended-latest']` (the repo's eslint crashes on every file under ESLint 10).
3. **Outstanding cross-area requests** (from the finished reports): engine `battle-events.publisher.ts` should stamp `eventId: randomUUID()` on every price tick; `redis.subscriber.ts` `handleBattleStarted` should call `broadcastCandleBatchOnNewBattle(payload.battleId)`; API must write `ticktrade:risk-terminal:watchers` (SET … EX 15 every 5 s while room `admin_risk_terminal` is non-empty; constants exported from `@ticktrade/shared`); API `ping` ack handler (`@SubscribeMessage('ping')` returning `{ok:true, server_time}`); optional: delete `redis-candle-history.service.ts`, drop `recentCandles` from `appResumeStore`/`ResumeSyncBridge`, remove the `chartDataFromSession` selector in `NewChartSessionAndLoadingOverlay.jsx`.
4. **Integration**: build all, restart the stack (`bash wb/tools/restart-backend.sh`, `wb start frontend admin`, `wb status`), watch logs for two rounds, run the smokes: `node tools/chart-parity-capture.cjs 90` (desktop + iPhone must receive identical candle streams and render identical charts), `node tools/round-boundary-shots.cjs` (cursor stays right through cooldown, no far-left jump, no cliff, ROUND ENTRY visible), `node tools/admin-tools-smoke.cjs`, `node tools/admin-shot.cjs "User Management|NPC Simulator|ORGANIC ENGINE"`; place BUY/SELL orders (`plan/impact-test.sh "buy 2000"` or the PWA) and confirm exact balance debits, a never-freezing timer, volume bars growing with notional, estimator updating within ~1 s.
5. **Adversarial review** of every change (`plan/workflow-review.js`: six lenses per repo — finance safety, behaviour regression, concurrency, cross-device determinism, contract consistency, code quality — three verifiers per finding, one fixer per repo). Money paths (balance flush, rollback, stake+debit atomicity, engine FIFO, settlement watchdog) deserve the most scrutiny.
6. **Final PDF**: chapter 1 executive summary; chapter 2 = `plan/report-ch2-findings.md`; chapter 3 "What changed" per area (start from each report's `notes_for_pdf`); chapter 4 new settings/env (all listed in the reports under `new_settings_env` — engine: `ENGINE_HEARTBEAT_BOUNDARY_OFFSET_MS`, `ENGINE_FINISH_IO_ATTEMPTS`, `ENGINE_FINISH_RETRY_MS`, `ENGINE_SETTLEMENT_WATCHDOG_MS`, `ENGINE_IDLE_WATCHDOG_GRACE_MS`, `RISK_TERMINAL_IDLE_INTERVAL_MS`; API/frontend constants as documented); chapter 5 how to test (unit suites, smokes, manual checks); chapter 6 deployment order (shared → engine + API + workers together, because the chart/candle contract changed on both sides; PWA and backend must ship together — an old PWA against the new API still works via the legacy reason-less subscribe path, but a new PWA needs the new API); chapter 7 known pre-existing test failures (3 shared, 12 engine). Render with the workbench's `md2pdf.cjs` (in `plan/`), same style as the previous report.
7. **Export/delivery**: `TAG=stabilisation bash wb/tools/export-npc-organic.sh` produces the three ZIPs and patches; update `wb/changes.json`; send ZIPs + PDF.

## 6. Recommended order for the next session

1. Unpack the three repo ZIPs and the tooling; bring the stack up (`wb setup` or bootstrap); confirm the table in §2 reproduces.
2. Finish F (api-core) — the money bugs first (F1/F2/F3 with regression tests), then F6, F7 (+C2 `timerUpdate` on subscribe, `range` in payload), F8/T2, F12/T3, F4 coalescer, F5, F9, F13–F17, watchers key, `ping`.
3. Finish E (npc) against plan section E; then G (admin UI) against C3/C4.
4. Wave-2 pwa-shell edits (§5.2) and the outstanding requests (§5.3).
5. Integration + smokes (§5.4), fix what breaks; then the adversarial review (§5.5) and fix confirmed findings.
6. PDF (§5.6), export (§5.7), deliver.

Engineering rules that applied throughout (keep them): no money-math change without a regression test; minimal explicit behaviour changes; every new env flag has a safe default and is documented; backend CRLF preserved; no secrets or model names in commits; product repos are never pushed — the client imports ZIPs manually.
