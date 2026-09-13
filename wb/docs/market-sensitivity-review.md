# Market Impact & Sensitivity — review, findings and fixes

Prepared for the TickTrade developer · 13 September 2026 · covers backend commit `22f8d91` and admin commit `87872d2`

## 1. The question that started this

You reported that a $100,000 SELL moved the price from 1.42938 to 1.42772 (16.6 pips) while the formula predicts 16.0 pips, and described the 0.6-pip gap as "normal, not exact every time".

That statement is not correct for the formula path. The real-user path in `computePriceFromImbalance` is a pure function of the admin config and the trade amount; with nothing else moving the price, a $100,000 order at those settings moves **exactly 16.0 pips, every time, at every price level**. We reproduced your test in the workbench with the NPC simulator stopped:

| Trade | Price before | Price after | Move | Formula |
|---|---|---|---|---|
| SELL $100,000 | 1.25544 | 1.25384 | −16.0000 pips | 16.0 |
| BUY $100,000 | 1.25384 | 1.25544 | +16.0000 pips | 16.0 |
| SELL $50,000 | 1.25544 | 1.25464 | −8.0000 pips | 8.0 |
| SELL $1,000 | 1.25544 | 1.25542 | −0.2000 pips | 0.16 → rounds to 0.2 on the 5-decimal quote |

Where did your extra 0.6 pip come from? From **other ticks in the same window**. With the NPC simulator running we repeated the test and the chart moved +18.4 pips in 2.5 seconds while the real $100k BUY itself moved exactly +16.0 pips; an NPC trade 750 ms later added +2.4 pips. The old Live Trade Log could not show this reliably (see finding 3), so the difference looked like noise. It is not noise: it is a second, separate pricing path (NPC market-pressure model) whose ticks landed inside your measurement window.

## 2. What was actually wrong in the code

### Finding 1 — a hidden, price-scaled minimum step still applied to real trades (bug)

Your fix removed `resolvePipSize` from the deterministic path, but `MarketStateService.applyTradeExecuted` still ran `enforceImmediateDirectionalMove` after it, for every trade. That function sizes its step with `resolvePipSize(startPrice)` (the price-scaled pip) times the book skew. Whenever the formula move rounded to zero on the 5-decimal quote (any real order under roughly $300 at your settings), this step fired instead:

| Trade (NPCs off, book leaning SELL) | Formula | Executed before the fix | Executed after the fix |
|---|---|---|---|
| SELL $10 | 0.016 pips | −0.8 pips | −0.1 pips |
| SELL $100 | 0.16 pips | −0.8 pips | −0.1 pips |
| SELL $300 | 0.048 pips | −0.8 pips | −0.1 pips |
| BUY $10 (book leaning SELL) | 0.016 pips | 0.0 pips | +0.1 pips |

So small real trades moved by an amount that depended on the book skew and on the price level (0.8 pips at 1.255, more at 1.42) and that the admin preview never showed; the same $10 order moved 0.8 pips or nothing depending on which side was heavier. This is exactly the class of "hidden adjustment" the client complained about, one layer further down.

**Fix.** Real trades are priced by the deterministic formula only. When the formula move is smaller than one quote tick (0.00001 = 0.1 pip) the trade registers exactly one tick in its own direction, at every price level, so the trader still sees the order land. `enforceImmediateDirectionalMove` now runs only for NPC (market-pressure) ticks, in the live engine and in the replay used by the audit tool.

### Finding 2 — the Price Movement Audit snapshot used the wrong config (bug)

`BattleSettlementService` snapshots the config with `getPipImpactConfig()` / `getPipImpactRoundOverride()` — in-memory getters that are only populated by the polling started in the **engine** process. Settlement runs in the **settlement-worker** process (the queue is on by default), which never starts that polling. Every queued settlement therefore stored the compiled-in defaults and replayed the round with them:

```
battle 28 (config in force: linear, sensitivity 8, multiplier 10)
stored pipImpactConfigUsed = {"curve":"log","sensitivity":5,"multiplier":1,...}
stored expectedEndPrice    = 1.25420   (actual 1.25573 — "variance" 0.12 %)
```

The audit page's PIP SENS., MULTIPLIER, EXPECTED MOVEMENT and VARIANCE columns were wrong for every round settled through the queue. Two smaller issues on the same page: the MULTIPLIER column showed `battle.eventMultiplier` (the round's event multiplier, a different setting), and the replay endpoint rounded the expected end price to two decimals (`roundMoney`), so a price such as 1.25384 was returned as 1.25.

**Fix.** When a round closes, the engine leader records the config the round was actually priced with (including a per-round override, which the engine clears right afterwards) in Redis under `ticktrade:market:pip_impact_used:<battleId>`. Settlement reads that record, falls back to the durable Redis config, uses the configured freeze seconds instead of a hard-coded 10, and stores it. The audit list now shows the Market Sensitivity multiplier, marks rounds where an override was active, and the replay keeps five decimals. Verified after the fix:

```
battle 32: stored {"curve":"linear","sensitivity":8,"multiplier":10,"roundOverrideApplied":false}
           expectedEndPrice 1.26291, actual 1.26395, variance 0.08 %
```

### Finding 3 — the Live Trade Log could not show every trade (bug)

The log was built from `price_ticks` rows that the API writes when it receives `engine:events:price.tick`. The engine coalesces that channel to one publish per 200 ms per battle (`shouldPublishEnginePriceTick`), so any trade landing within 200 ms of the previous tick was never written, and its pips disappeared from the totals. In addition, the persistence is disabled entirely under `LIVE_BATTLE_REDIS_ONLY` (`priceTickPgPersistEnabled()` returns false), and "Total This Round" summed only the last 50 rows.

**Fix.** The engine publishes a new event, `engine:events:trade.priced.v1`, once per priced trade (real and NPC), outside the coalescer, with the realised move on the 5-decimal quote. The API persists those rows independently of the price-tick flag (`TRADE_PRICED_PG_PERSIST`, default on). The round total is now measured on the price itself (start price → current price), the real / NPC split comes from all rows of the round, and anything left is shown as "other (rounding)". Each real row shows the formula value next to the actual move so a mismatch is visible at once (with a marker when settings changed mid-round).

### Finding 4 — saves took up to 5 seconds to reach the engine

The engine only polled the Redis config every 5 s (override every 3 s). A trade placed right after "Save Configuration" used the old numbers, although the page said "changes take effect immediately".

**Fix.** Every save is also published on `engine:events:market.sensitivity.v1`; the engine applies it the moment it arrives (pollers remain as fallback). Verified: multiplier changed and a trade placed 300 ms later already used the new value.

### Finding 5 — admin page tools that did not do what they said

* **Date Range** filter on the change history was wired to state that nothing read; it did nothing.
* **Search** and **Field Filter** filtered only the five rows of the current page, so a change on page 3 could never be found.
* **Reference Amount / Reference Pips** — the two numbers that anchor the whole curve — were not editable on the page (the API already accepted them).
* The per-round override input accepted 0, which the API rejects; the toggle did not follow the automatic clear at round end.
* The Live Preview divided by a hard-coded 5 while the engine divides by `PRICE_SENSITIVITY_DEFAULT` (env-overridable); it also showed 0.02 pips for a $10 trade although the quote cannot show less than 0.1 pip.
* The Price Movement Audit list returned only flagged rounds, so "Pass Rate" was computed from a list that contained only failures, and the "Pass" status filter could never show anything.

**Fix.** All three history filters run on the server across the full history (CURVE and REFERENCE options added). Reference Amount and Reference Pips are editable and saved with the configuration. The override input is clamped to 1–10 and the toggle polls the real state. The preview shows two figures: the settings on the page (including unsaved edits) and what the engine executes right now (new endpoint `GET /admin/market-sensitivity/preview`, which runs the engine's own function with the live price and the sensitivity in force); both show the formula pips, the executed move after quote rounding, and the price before → after. The audit list returns every settled round with PASS/FAIL, a period-wide summary, and a server-side status filter.

## 3. What was already right

* The formula itself: `curve(amount) × (sensitivity ÷ 5) × multiplier`, with linear / sqrt / log curves as documented.
* Removing `resolvePipSize` from the deterministic path: correct, and kept.
* The per-round override: applied correctly (sensitivity 4 → exactly 8.0 pips for $100k) and cleared at round end.
* The formula does not depend on pots, smoothed pressure, elapsed time or the finalize window; we added tests that pin this down.

## 4. How to see it yourself

1. Admin → Market Impact & Sensitivity → Live Preview: type an amount, choose BUY/SELL. The right-hand box is the engine's own function with the live price; it is what the next trade will do.
2. Place the trade. In the Live Trade Log the REAL row shows FORMULA and ACTUAL side by side (equal, unless the settings changed after the trade). Other rows are NPC ticks — that is where a chart reading over a time window picks up extra pips.
3. To measure the formula alone, stop the NPC simulator; with it running, read the REAL row, not the chart.
4. Small orders: anything whose formula move is under 0.1 pip moves exactly 0.1 pip (the quote's resolution), shown in the preview as "floored to 0.1 pip".

## 5. Files changed

Backend: `packages/shared/src/battle/price-from-imbalance.ts`, `price-audit-replay.ts`, `price-impact-deterministic.spec.ts` (new), `events/pip-impact-config.redis.ts`, `events/trade-priced.v1.ts` (new); `apps/engine/src/market/market-state.service.ts`, `events/trade-executed.handler.ts`, `battle/battle-events.publisher.ts`, `battle/battle-engine.service.ts`, `battle/battle-settlement.service.ts`, `index.ts`; `apps/api/src/admin/market-sensitivity.service.ts`, `admin.controller.ts`, `price-movement-audit.service.ts`, `redis/redis.subscriber.ts`.

Admin: `src/Pages/AdminDashboard/MarketSensitivity.jsx`, `src/Pages/PriceMovementAudit/index.jsx`, `src/store/slices/adminSlice.js`.

No schema change, no new environment variable required (`TRADE_PRICED_PG_PERSIST=0` disables the per-trade rows if ever needed).

## 6. Verification

* New unit tests (8): exact 16.0 pips for the reported case; identical pips at prices 0.9 … 4.5; pots / pressure / elapsed / finalize have no effect; quote-tick floor; sensitivity and override factors; sqrt and log curves; replay equals live pricing.
* Existing suites unchanged: shared 219/222 and engine 82/95 — the remaining failures are pre-existing tests in the legacy hedge and pricing specs that fail on your drop before any of these changes.
* Workbench (real stack): NPC-off trades at $10 … $100,000 exact at every size; push applied before a trade 300 ms after saving; NPC-on round with the log separating the exact +16.0 real move from NPC ticks; settlement snapshot correct; admin page browser checks 20/20.
