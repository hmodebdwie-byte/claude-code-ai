# TickTrade — brief for the next engineering session (read this first, then start at item 5)

You are taking over an in-progress stabilisation of **TickTrade**, a real-money trading game: a NestJS + Prisma + Redis backend (`ASPR-backend-`: API, battle engine, settlement worker, NPC worker), a React 19 trading PWA (`Tick-Trade-project-APSR`) and a React admin app (`APSR-admin-`). The owner will give you the three code ZIPs; this kit gives you everything else: the specification, the root-cause audit, the completion reports of the finished parts, the workbench that runs the whole stack locally, the smoke/screenshot tools, and this brief.

**Money is real. No change to a money path without a regression test. No guessing: read the code, reproduce, then fix.**

---

## A. How the owner wants to work with you

1. Work through the checklist in section D **one item at a time, in order**, starting at the item named in section B.
2. Before you start an item, say in two or three sentences what the item is and what you will do.
3. An item is finished only when: the code is implemented, the affected packages build, the unit suites pass (no new failures against the baselines in section C.5), you added regression tests for what you changed, and — where the item says so — you verified it at runtime in the local stack (screenshots, socket captures, manual trades).
4. When an item is finished: commit it in the affected repo(s) (`git commit`, never push — there is no remote), create the ZIP(s) of the affected repo(s) (section F), write a short change note (what changed, files, new settings, how to test), **send the ZIP(s) and the note, then STOP and wait for the owner to say "continue"**. Do not start the next item on your own.
5. If an item turns out to be impossible or dangerous as specified, say so before changing anything, propose the alternative, and wait.
6. Keep a running log `CHANGELOG-items.md` (one section per finished item) — it becomes the input for the final PDF (item 15).
7. The owner is not a developer of this code; they import ZIPs into their own tool and forward reports to their dev team. Write change notes for that dev team: plain English, file paths, how to test.

---

## B. Where we are — jump straight to the point

| Item | Status |
|---|---|
| 0 Environment + baseline | do it first on your machine (no ZIP) |
| 1 Backend chart pipeline (continuous candle stream) | **DONE** in the code you have (unit-tested, not runtime-verified) |
| 2 PWA chart (continuous series, time cursor, ROUND ENTRY autoscale, volume scale) | **DONE** (unit-tested, not runtime-verified) |
| 3 PWA timer / pool bar / estimator / shell performance | **DONE** (unit-tested, not runtime-verified) |
| 4 Engine stability and performance | **DONE** (unit-tested, not runtime-verified) |
| 5 API money paths (balance flush, rollback, stake+debit atomicity) | **PARTIAL — start here** |
| 6 API idempotency + crash safety | partial / to do |
| 7 API subscribe pipeline, timer on subscribe, small cross-area requests | to do |
| 8 API fan-out and timer relay | to do |
| 9 Legacy NPC backend completion | partial |
| 10 PWA shell (useWebSocket.js wave-2 edits + dead-code removal) | to do |
| 11 Admin: Organic Engine tab redesign | to do (admin app untouched so far) |
| 12 Admin: NPC Behavior / NPC Traders / Rotation tab fixes | to do |
| 13 Integration and smoke runs across all three apps | to do |
| 14 Adversarial review of every change + fixes | to do |
| 15 Final detailed PDF + final ZIPs + change log | to do (chapter 2 already written) |

The code ZIPs the owner has are at these commits: backend `7fc9374` ("wip(stabilisation): chart stream, engine stability, partial NPC and trade-path work"), frontend `5dc9950` ("wip(stabilisation): continuous chart series, local countdown, pool-bar labels, estimator throttle"), admin `fbd4dd0` (last delivered admin drop, unchanged in this effort). If the ZIPs you receive carry a `.git` folder, `git log -1` must show these; if they carry no `.git`, the workbench bootstrap creates a baseline commit from the ZIP content — fine, just do not re-apply the patches in `wb/patches.reference` (they are already in the code; they are there for reading only).

Everything below assumes you have read `HANDOFF.md` (status detail), `plan/fix-plan.md` (the specification with the pinned contracts C1–C4 and the per-area scopes A–G) and the relevant `plan/audit-*.md` before touching code.

---

## C. Setting up the stack on your machine

### C.1 Prerequisites
Node 22, pnpm 10, PostgreSQL 16, Redis 7, Chromium for Playwright (`npx playwright install chromium` in the workbench tools folder if the smokes complain), network access to `registry.npmjs.org` and `binaries.prisma.sh` (Prisma engines download). The stack was developed on Linux; macOS works the same; on Windows use WSL.

### C.2 One-shot bring-up with the workbench
The kit contains `wb/` — the workbench. Its `tools/wb.sh` is a CLI (`wb setup | install | env | db:migrate | db:seed | db:reset | build | start | stop | restart | status | logs | test | probe | ports`). It expects the repos at `/home/claude/wb/{backend,admin,frontend}` and its own files at `/home/claude/wb` (edit the `WB=` variable at the top of `tools/wb.sh` and `bootstrap.sh` if you must use another path).

1. Put the three code ZIPs in a folder, e.g. `~/uploads` (names must contain `backend`, `admin`, `Tick-Trade`).
2. Unpack this kit; **rename `wb/patches` to `wb/patches.reference`** (the code you have already contains those commits; bootstrap would try to re-apply them).
3. `bash wb/bootstrap.sh ~/uploads` — unpacks the repos into `/home/claude/wb/`, git-inits them if needed, links the `wb` command, then runs `wb setup`: starts Postgres/Redis if installed locally, generates `env/backend.env` (synthetic local secrets, seed users), installs dependencies, `prisma generate`, migrates, seeds, builds and starts every service.
4. `wb status` (every row `up`, API health 200), `wb ports` (PWA http://127.0.0.1:18771, admin http://127.0.0.1:18772, API http://127.0.0.1:18773, Swagger `/docs`). Logins: `SEED_ADMIN_EMAIL/PASSWORD` and `SEED_DEMO_EMAIL/PASSWORD` from `wb/env/backend.env` (generated by `wb env`; `env/backend.env.example` in the kit lists the keys).
5. `wb test` runs the api / engine / shared / admin-regression suites.

If `wb setup` fails at a step, run the steps by hand (they are plain commands inside `tools/wb.sh`): `pnpm install` in the backend, `npm install` in frontend and admin, `pnpm --filter @ticktrade/shared build`, `pnpm --filter api build`, prisma migrate + seed, `npx vite build` in frontend/admin, then `wb start`.

### C.3 Day-to-day commands
- Backend after a change: `cd /home/claude/wb/backend && pnpm --filter @ticktrade/shared build && pnpm --filter api build` (engine runs under ts-node; `npx tsc --noEmit -p apps/engine/tsconfig.json` is its check) then `bash /home/claude/wb/tools/restart-backend.sh` (restarts api, engine, engine-worker, settlement-worker, npc-worker).
- Frontend/admin after a change: `npx vite build` in the repo, then `wb restart frontend` / `wb restart admin` (static servers serve `dist/`).
- Logs: `wb logs api 200`, `wb logs engine 200`, etc. Backend source files are **CRLF** — keep them CRLF (`plan/patchlib.py` patches safely; verify with `file <path>`).
- Redis inspection: `redis-cli` (keys of interest: `chart:history:all`, `ticktrade:price:last`, `ticktrade:npc:*`, `market:state:<battleId>`, `ticktrade:battle:meta:<id>`). Postgres: `psql "$DATABASE_URL"` (tables `battles`, `stakes`, `price_ticks`, `npc_trades`, `system_settings`, `npc_round_audit`, `users`).

### C.4 Smoke and capture tools (in `wb/tools/`)
- `admin-tools-smoke.cjs` — logs into the admin app and checks the risk/inspection pages.
- `chart-parity-capture.cjs [seconds]` — logs the demo user into a desktop context and an iPhone 13 context at the same time, records every socket.io frame, screenshots both charts, writes `run/smoke/parity-report.json` (per-event counts, price sequences, `comparison[ev].identicalPriceSequence`). Acceptance: identical candle streams and identical charts.
- `round-boundary-shots.cjs` — waits for the end of the current round on the phone context and screenshots T−5, T−1, T+1, T+6, T+16, T+34 and the next round +1/+4/+12 (`run/smoke/boundary-*.png`). Acceptance: cursor stays at the right edge through cooldown, no far-left jump, no vertical cliff, ROUND ENTRY visible.
- `admin-shot.cjs "Group|Item[|Tab]"` — screenshot of an admin page, e.g. `"User Management|NPC Simulator|ORGANIC ENGINE"`, `"Trading & Battles|Battle Settings"`, `"Trading & Battles|Market Impact & Sensitivity"` (design references for item 11 are also in `wb/run/smoke/admin-*.png`).
- `plan/impact-test.sh "buy 2000" "sell 500"` — places orders through the API as the demo user (reads the env file for credentials).
- `plan/md2pdf.cjs <in.md> <out.pdf>` — renders the final report (same style as the previous report in `plan/previous-report/`).

### C.5 Baseline you must reproduce before item 5 (and never regress)
| Package | Check | Expected |
|---|---|---|
| backend `packages/shared` | `pnpm --filter @ticktrade/shared build`; `cd packages/shared && pnpm test` | build ok; 266 pass / 3 fail (the 3 are pre-existing `last-moment-company-hedge` failures) |
| backend `apps/api` | `npx tsc --noEmit -p apps/api/tsconfig.json`; `pnpm --filter api build`; `cd apps/api && npx jest` | clean; clean; 78/78 |
| backend `apps/engine` | `npx tsc --noEmit -p apps/engine/tsconfig.json`; `cd apps/engine && pnpm test` | clean; 119 pass / 12 fail (12 pre-existing pricing / npc-simulator.protection failures) |
| backend `apps/npc-worker`, `apps/settlement-worker` | `npx tsc --noEmit -p apps/<app>/tsconfig.json` | clean |
| frontend | `npx vite build`; `node --test "src/**/*.test.js"` | clean; 63/63 |
| admin | `npx vite build` | clean |

---

## D. The checklist

Each item lists: goal · what already exists · tasks · acceptance · verification · deliverable. "Plan §X" refers to `plan/fix-plan.md`; "audit X-Fn" to `plan/audit-<area>.md`; "report" to `plan/reports/*.json` (`notes_for_pdf` inside each report is ready-made explanation text).

### Item 0 — Environment and baseline (no ZIP)
Bring the stack up (section C), reproduce the baseline table (C.5), open the PWA as the demo user and the admin as the seed admin, watch one full round (300 s battle + 30 s cooldown by default). Report the table and any deviation. Then wait for "continue".

### Items 1–4 — DONE (do not redo; runtime verification happens in item 13)
- **1 Backend chart pipeline** (report `A_chart-api…json`): `apps/api/src/ws/line-chart.gateway.ts` now keeps one continuous 1-second candle stream (`all` scope) that also covers cooldown seconds; `candleClosed` every second; `candleBatch` = last 600 s + in-progress bucket, `replace:true`; `priceUpdate` gains `bucket_ts` + `volume`; eventId dedupe; TTLs. Contract C1.
- **2 PWA chart** (report `B_chart-pwa…json`): continuous store, wall-clock axis, time cursor from a server-offset clock (`chartClockService.js`, `chartGeometryService.js`), fixed bar spacing, ROUND ENTRY inside autoscale, histogram scaled to the whole loaded series, RAF loop idles.
- **3 PWA timer / pool bar / estimator** (report `C_pwa-panel…json`): local countdown anchored to server frames (`timerCountdownAnchor.js`), labels outside the clamped fills, fetch-loop throttling (`requestThrottle.js`), resume hygiene, watchdog floor + ping probe, PWA cache config.
- **4 Engine** (report `D_engine…json`): per-battle FIFO trade handling, finish ordering + settlement/idle watchdogs, continuity price DB fallback, leader resilience, dedicated timer Redis connection, unhandledRejection guard, coalescer volume accumulation + trailing flush, risk-terminal cadence, Lua trader count. New env flags listed in the report (`ENGINE_HEARTBEAT_BOUNDARY_OFFSET_MS`, `ENGINE_FINISH_IO_ATTEMPTS`, `ENGINE_FINISH_RETRY_MS`, `ENGINE_SETTLEMENT_WATCHDOG_MS`, `ENGINE_IDLE_WATCHDOG_GRACE_MS`, `RISK_TERMINAL_IDLE_INTERVAL_MS`).

### Item 5 — API money paths (START HERE) → backend ZIP
Goal: audit api-ws-perf F1, F2, F3 fixed with regression tests. Plan §F first bullet.
What exists (partial, unreviewed): `apps/api/src/trades/user-balance-flush.service.ts` (+192 lines, atomic drain attempt), `user-spendable-balance.service.ts` (+108), `battle-stake-buffer.service.ts` (+31), parts of `trades.service.ts` (+435 incl. constituent idempotency-key storage), `packages/shared/src/payout/live-projection-memo.ts` (+spec).
Tasks: `git show HEAD -- apps/api/src/trades` and read every hunk. Ensure: (a) the pending-debit drain is atomic (Lua HGETALL+DEL or RENAME to a per-flush key; on Postgres failure the amounts are added back); (b) negative pending values (rollbacks) are applied as `increment`, never clamped away; (c) the dirty-user set is drained with SPOP-style semantics; (d) stake-buffer append and pending debit are atomic (one MULTI/Lua) or stake-first with reconciliation; (e) jest specs with a Redis mock cover: concurrent HINCRBYFLOAT during flush is not lost; rollback after flush credits the user; crash between debit and stake leaves no orphan debit.
Acceptance: `npx jest` green including the new specs; `pnpm --filter api build` clean; manual: place 10 rapid orders as the demo user, balance in Postgres equals initial − sum(stakes) exactly; force a rejected order (e.g. amount above balance) and confirm no debit remains in Redis or Postgres.
Deliverable: backend ZIP + note.

### Item 6 — API idempotency + crash safety → backend ZIP
Goal: audit api-ws-perf F4, F5, F6, F15. Plan §F.
What exists: `trade-order-coalescer.ts` only gained a `idempotencyKeys` meta field; `trades.service.ts` stores results under constituent keys. Not done: same-key dedupe inside `submit`, derived batch key when >1 distinct keys; worker-side `results.get(commandId)` check + BullMQ `lockDuration ≥ tx timeout` + `maxStalledCount: 0`; `.catch` on every `void` promise in `redis.subscriber.ts` and `trades.service.ts`; `process.on('unhandledRejection')` in `apps/api/src/main.ts` and the worker mains; `TradesService` emitting through `WS_EMIT_PORT` so worker-side `balanceUpdated` / `notification` / `equityUpdated` reach sockets.
Acceptance: specs for coalescer dedupe and worker replay; API keeps running when a handler rejects (simulate by throwing in a test handler); after an async trade the PWA receives `balanceUpdated`.
Deliverable: backend ZIP + note.

### Item 7 — API subscribe pipeline, timer on subscribe, cross-area requests → backend ZIP
Goal: audit F7, F10, F17 + contract C2 server side + the small requests from the finished areas.
Tasks: `subscribeToBattle` dedupes the whole pipeline per socket within 3 s, accepts `range` in the base payload, removes the duplicate dashboard emit, caches active battle id / bootstrap snapshot / chat history / top traders per battle (invalidate on battle events); rate-limit buckets for `subscribeToBattle` and `chatHistory`; `broadcast_to_all` restricted to ADMIN; emit one `timerUpdate` at the end of `subscribeToBattle` from Redis battle meta (`startTimeMs + durationSeconds`). Cross-area requests: engine `battle-events.publisher.ts` stamps `eventId: randomUUID()` on every price tick; `redis.subscriber.ts handleBattleStarted` calls `broadcastCandleBatchOnNewBattle(payload.battleId)`; API writes `ticktrade:risk-terminal:watchers` (`SET … EX 15` every 5 s while room `admin_risk_terminal` is non-empty; constants `RISK_TERMINAL_WATCHERS_REDIS_KEY/TTL_SEC` in `@ticktrade/shared`); `@SubscribeMessage('ping')` ack handler returning `{ ok: true, server_time }` excluded from rate limits; optional: delete `redis-candle-history.service.ts`.
Acceptance: a reconnecting client gets one bootstrap of each event; a `timerUpdate` arrives immediately after subscribe; DB query count per subscribe drops from ~50 to a handful (log Prisma queries or count with `pg_stat_statements`).
Deliverable: backend ZIP + note.

### Item 8 — API fan-out and timer relay → backend ZIP
Goal: audit F8/T2, F12/T3, F9, F13, F14, F16, E2/E3 server side. Plan §F.
Tasks: one shared `battleSnapshot` emit per room + per-user `free_taps_left` only when it changes; top-traders decoupled from the snapshot flush (respect its throttle); dashboards on trade events and ≥1 s; `emitActiveTradeStreamUpdatesForBattle` off the timer tick (own guarded 1 s interval); wire the shared projection memo (`live-projection-memo.ts`) into dashboard, trade stream, balance snapshot, market-flip and estimate handlers; bound `priceTick.findMany`; emit `battleEnd` immediately (pacer drains in background); keep forwarding when the broadcaster lease is lost on single-instance deployments (`WS_SINGLE_INSTANCE` default true, log loudly); single flush timer instead of per-call setTimeout yields; `WS_LOCAL_EMIT=true` default → `server.local` emits when the Redis adapter is on and single instance; activeTradeStream maps keyed consistently and cleared; per-user maps cleaned on battle end/disconnect; `pingInterval 15 s / pingTimeout 25 s`; auth verdict cached 5 s per socket; dashboard price from `resolveLiveCurrentPrice` (Redis last price) not the DB tail; estimate endpoint served from the memo.
Acceptance: with the NPC engine running, `redis-cli monitor` shows no top-traders SQL per snapshot flush; timer frames on the wire stay 1000 ms ± 50 ms during a busy round (capture with `chart-parity-capture.cjs` frames: `timerUpdate` gaps).
Deliverable: backend ZIP + note.

### Item 9 — Legacy NPC backend completion → backend ZIP
Goal: plan §E (contract C3) complete. Audit `legacy-npc` BUG-1…BUG-12, INV-5, INV-8.
What exists (partial): durable ON/OFF with DB fallback and default OFF (`packages/shared/src/events/npc-simulator.redis.ts` + spec), engine-mode mirror-back + DB fallback (`engine-mode.redis.ts` + spec), rotation session-per-round (`npc-participation-session.ts` + spec), selection gate (`npc-selection-gate.ts` + spec), force-win row precedence (+spec), NPC trade coalescer accumulating fills (+spec), recent-trades ring + status source in `admin-npc.service.ts`, rotation DTO/service with `npc_rotation_starvation_policy` and `npc_rotation_timezone_offset_minutes`, organic eligibility filtering, npc-worker wiring, updated startup regression.
Tasks: check every plan §E bullet against `git show HEAD -- apps/engine/src/npc apps/engine/src/npc-organic apps/npc-worker packages/shared/src/npc packages/shared/src/events/npc-simulator.redis.ts apps/api/src/admin`. Likely missing: all five producers (simulateTick, liquidity heartbeat, intelligence runner, reactive bursts, defense paths) through the gate; LRU using real last-participation timestamps and round-robin via the Redis cursor; `rotationPaused` respected everywhere; `npc_volume_target_amount_nudge_max` implemented; `defenses.finalInjectionLeadMs` re-armed on change, help text and `hidden` flag in `settings.ts`; asymmetry plan keyed by `stats.battleId` (BUG-11); window evaluated with the timezone offset (BUG-12); `trades.service.ts` engine-mode call sites using the DB-fallback reader.
Acceptance: shared + engine suites green vs baseline; with `npc_engine_mode = legacy` and rotation enabled, the admin status shows the same NPC never exceeds the per-round caps and `rotation_starved` flips when the pool is exhausted; STOP survives `redis-cli FLUSHALL` + worker restart (NPCs stay off).
Deliverable: backend ZIP + note.

### Item 10 — PWA shell → frontend ZIP
Goal: the wave-2 edits to `frontend/src/utils/useWebSocket.js` requested by items 1–3 (exact code in `plan/reports/*.json` → `requests_for_other_agents`) plus dead-code removal. Plan "WAVE 2".
Tasks: remove the sessionStorage-candle plumbing and dead backfill code, then delete `src/utils/persistCandleClosedSession.js`, `src/live/services/chartHydrationService.js`, `src/live/services/battleLineChartResubscribeService.js`, `src/live/pipeline/chartPipeline.js`; trim `battleResetService.js` / `storeDrivenBattleTransitionService.js`; timer battle-id adoption (T10); watchdog call-site values + `onAlive`; single foreground sync path (drop the focus/pageshow/visibilitychange listeners in useWebSocket, keep ResumeSyncBridge's) and dedupe forced `syncNow` (1 s); one `subscribeToBattle` emit carrying `range` (server side from item 7); remove `subscribeToPrice`; reconnect handlers on `socket.io` (manager); remove dead `marketSnapshot`/delta branches; no client `subscribe` on line-chart connect; `subscribe {scope:'all', reason:'resync'}` on foreground/stale; drop `recentCandles` from `appResumeStore`/`ResumeSyncBridge`; remove the `chartDataFromSession` selector in `NewChartSessionAndLoadingOverlay.jsx`. Fix `eslint.config.js` (`reactHooks.configs.flat['recommended-latest']`).
Acceptance: `npx vite build` clean; `node --test` green; eslint runs; in the parity capture the phone performs the session bootstrap ONCE per connect.
Deliverable: frontend ZIP + note.

### Item 11 — Admin: Organic Engine tab redesign → admin ZIP
Goal: plan §G first bullet, contract C4. Design language: `wb/run/smoke/admin-battle-settings.png`, `admin-market-impact-sensitivity.png` (rows with label / value / pencil edit that saves immediately, info stripes under each row, stepper cards, "Save Configuration", Live Preview card with • LIVE pill). Current tab: `admin-organic-engine.png`. Keep the REST contract (`GET /admin/npc/organic/schema`, `GET/PUT /settings`, `/mode`, `/status`, `/live`, `/rounds`, `/settings/reset`); pencil edit = PUT the full values document with the one changed field.
Tasks: sticky live strip; section nav (Engine, Round start, Momentum, Tiers, Asymmetry, Defenses, Audit); `.battle-detail-item` rows with applies badge (`live` / `next round`), pencil → `.modal-card` editor with help, min/max/default, validation; info stripe per row; computed previews per section (arrivals/min curve summary, tier stake ranges, expected initial-wave window, "peak now: yes/no"); MarketSensitivity-style live card (stat boxes, pot bar, recent NPC trades table); Round audits kept; toggles save immediately; keep "Switch to legacy/organic" with confirm; works at 1280 px and 390 px.
Acceptance: `npx vite build` clean; `node tools/admin-shot.cjs "User Management|NPC Simulator|ORGANIC ENGINE"` screenshot reviewed; editing a field via the pencil changes the value returned by `GET /settings` and the engine-applied version advances.
Deliverable: admin ZIP + note.

### Item 12 — Admin: NPC Behavior / NPC Traders / Rotation tabs → admin ZIP
Goal: plan §G remaining bullets, contract C3 (audit BUG-8, BUG-9, rotation keys).
Tasks: Behavior tab default `normal`, aggression max 3 step 0.1 with clamp note, copy "scales stake sizes and defense caps (0.3–3×), does not change timing"; NPC Traders status from worker heartbeat + `desired_active_source`, recent trades list from `recent_trades` (poll 5 s while the tab is open); Rotation & Limits: "Starvation policy" (relax / pause) radio and "Timezone offset (minutes)" input with info boxes; warning card when status reports `rotation_starved`.
Acceptance: build clean; screenshots of the three tabs; values round-trip through the API.
Deliverable: admin ZIP + note.

### Item 13 — Integration and smokes → ZIP(s) of whatever changed
Build everything, restart the stack, watch the logs for two full rounds (no crashes, no unhandled rejections, no Prisma pool timeouts), then: `node tools/chart-parity-capture.cjs 90` (identical streams and charts on desktop and phone), `node tools/round-boundary-shots.cjs` (cursor stays right through cooldown, no far-left jump, no cliff, ROUND ENTRY visible — view every PNG), `node tools/admin-tools-smoke.cjs`, admin screenshots; place BUY/SELL orders (`plan/impact-test.sh "buy 2000"` and by hand in the PWA on the phone context) and confirm exact balance debits, a never-freezing timer (also while the NPC engine floods trades), volume bars growing with notional (a $100k bar taller than a $10k bar on the same chart), the estimator switching to LOSING within ~1 s of the price crossing the entry, both pool labels always readable. Fix what fails in any repo.
Deliverable: ZIP(s) of the repos that changed + the screenshots + a verification table.

### Item 14 — Adversarial review + fixes → ZIP(s)
Use `plan/workflow-review.js` as the recipe (with or without an orchestration tool): for each repo review `git diff <baseline>..HEAD` under six lenses — finance safety, behaviour regression (grep the other repos for event/function names you removed or renamed), concurrency/stability, cross-device determinism, contract consistency across repos (C1–C4), code quality (CRLF, any-casts, hot-path logging) — write each finding with file:line and a concrete failure scenario, then try to refute each finding before accepting it, then fix the confirmed ones with tests. The money paths (items 5–6), engine FIFO/finish/watchdogs (item 4) and the chart contract (items 1–2, 10) deserve the deepest pass.
Deliverable: ZIP(s) + the review table (confirmed / rejected with reasons).

### Item 15 — Final detailed PDF, final ZIPs, change log
The owner's dev team needs one long PDF explaining exactly what changed and how to test it. Structure (continue the style of `plan/previous-report/TickTrade-Engineering-Report-2026-09-14.pdf`): 1 executive summary mapped to the owner's five points; 2 = `plan/report-ch2-findings.md` verbatim (what we found, with evidence); 3 what changed, per area (start from each report's `notes_for_pdf` and your item notes); 4 new settings / env flags with defaults; 5 how to test (unit suites, smokes, manual checks); 6 deployment order (shared → engine + API + workers together, PWA and backend must ship together — old PWA still works against the new API via the legacy subscribe path; new PWA needs the new API); 7 known pre-existing test failures (3 shared, 12 engine); 8 things deliberately left alone. Render with `plan/md2pdf.cjs`. Produce the three final ZIPs (section F) and update `wb/changes.json`.
Deliverable: three ZIPs + the PDF.

---

## E. Engineering rules (apply to every item)
1. Finance app: never change money math unless the plan says so; every money/state change gets a regression test; prefer the safer fix.
2. Minimal, explicit behaviour changes; no refactors for style; keep the pinned contracts C1–C4 unless the owner agrees to a change.
3. Every new env flag has a safe default and is listed in the change note.
4. Backend files stay CRLF; no secrets, no model names, no AI names in code, comments or commit messages.
5. Never push anywhere; the owner's local folder is the source of truth.
6. Do not skip, disable or delete a test to get green; the 15 pre-existing failures are documented and must stay the only failures.
7. When you are unsure whether a change is wanted, ask before doing it; when the owner reaffirms, do it.

---

## F. How to package a deliverable ZIP
After committing in the repo (`git add -A && git commit -m "item N: <title>"`), from the repo root:

```
# backend
git archive --format=zip --prefix=ASPR-backend-/ -o ../export/ASPR-backend--dev-itemNN-YYYY-MM-DD.zip HEAD
# frontend (trading PWA)
git archive --format=zip --prefix=Tick-Trade-project-APSR/ -o ../export/Tick-Trade-project-APSR-dev-itemNN-YYYY-MM-DD.zip HEAD
# admin
git archive --format=zip --prefix=APSR-admin-/ -o ../export/APSR-admin--dev-itemNN-YYYY-MM-DD.zip HEAD
```
(`git archive` excludes `node_modules`, `dist` and everything ignored — that is what the owner expects.) Also `git format-patch -1 HEAD -o ../patches/<repo>/` so the dev team can read the diff. Send the ZIP(s) with the change note, then stop and wait for "continue".

---

## G. What is in this kit
- `NEXT-AI-BRIEF.md` / `.pdf` — this document.
- `HANDOFF.md` / `.pdf` — detailed status per area at the moment of handoff (files, tests, what is partial, outstanding cross-area requests with exact code).
- `plan/fix-plan.md` — the specification (contracts C1–C4, scopes A–G, operating rules).
- `plan/audit-*.md` (7) — root-cause audit with file:line evidence; `plan/reports/audit-map-full.json` — the same as one JSON.
- `plan/report-ch2-findings.md` — chapter 2 of the final PDF, ready.
- `plan/reports/*.json` — completion reports of items 1–4 (files, behaviour changes, tests, verification, `notes_for_pdf`, requests for other areas).
- `plan/workflow-implement.js`, `plan/workflow-review.js` — the orchestration recipes used (read them as prompts/checklists).
- `plan/patchlib.py`, `plan/md2pdf.cjs`, `plan/impact-test.sh` — helpers.
- `plan/previous-report/` — the earlier engineering report (style and numbering to continue).
- `wb/` — the workbench: `bootstrap.sh`, `tools/` (`wb.sh`, `restart-backend.sh`, smokes and capture tools), `docs/`, `changes.json`, `run/smoke/*.png` (design references and the boundary/parity evidence), `patches.reference/` (all commits of the engagement as git patches, already contained in the code you have).
- `env/backend.env.example` — the keys the backend needs (values are generated by `wb env`).
- `patches-wip/` — the two WIP commits as patches (backend 0008, frontend 0007) for reading what items 1–4 (and the partial 5/6/9) changed.
