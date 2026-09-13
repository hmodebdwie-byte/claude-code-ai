# TickTrade NPC Organic Engine — design (implements the Master NPC Directives v2.1 + Live Testing memo)

## 1. What is wrong today (verified in code)

Three independent systems react to every real trade, instantly:

| Where | What it does | File |
|---|---|---|
| API, inside the user's own trade transaction | `computeNpcDominanceProtectionPlan` places NPC counter-chunks on the opposite side in the same tx (`NPC_DOMINANCE_PROTECTION_ON_USER_ORDER=true` by default); last-moment hedge `diff × 1.2` | `apps/api/src/trades/trades.service.ts:1846-2387`, `dominance-protection-gate.ts` |
| npc-worker listener | "reactive burst": 3–4 counter trades within 5–8 s of any bet ≥ $5k; emergency pot flips in the last 15 s | `apps/npc-worker/src/npc-worker.command.listener.ts:195-430` |
| Legacy simulator loop (16,696 lines) | whale-spam defense, late-instant defense, counterbalance servo (parity 0.64–1.5), weak-side support, force-win at close, house pot alignment | `apps/engine/src/npc/npc-simulator.service.ts` |

Settings: 99 `system_settings` keys re-read by a 60 s poll (`NPC_CONFIG_REFRESH_MS`), no push invalidation
(`config.updated.v1` is declared but never published). The admin page shows hard-coded defaults until the
GET resolves and its two main levers (pace, aggression) only retune the reactive layers above. Several keys are
dead (`npc_valid_stake_amounts`, `liquidity_heartbeat_interval_ms`, `npc_counter_win_flip_last_sec`).

Settlement ("Model A"): real losers' net pool is split by score between real winners **and NPC winners**
(the NPC share is retained by the house). Winner = pot dominance, except a hidden rule that picks the side
with the *smaller* real pot whenever both sides have real users (`house_max_real_loser_pool`). There is no
round lock: the 1 s heartbeat settles at `remaining <= 0`, and a "grace" key *delays* settlement so late NPC
counters can land.

## 2. Target behaviour (the directives, made precise)

Notation per round: `V_rl` real losing volume (net per user), `V_sl` simulator losing volume, `S_rw`/`S_sw`
score sums of real/sim winners, `fee` platform commission rate, `R = V_rl × (1 − fee)` net real loser pool,
`Pot = R + V_sl` distributable pool.

* **Company net = fee × V_rl** exactly (commission on the real losing pool only).
* **Simulator net = 0**: it gets back exactly its seed (`V_sw` stake return + `V_sl` profit share).
  Zero-profit cap: `sim_profit = min(V_sl, Pot × S_sw / (S_rw + S_sw))`; any surplus goes to real winners.
* **Real winners collectively receive exactly R (+ nothing more, nothing less)** whenever the simulator is
  protected. Split among them by Model-A score.
* **Lightning Dilution (Defense B)**: if the score split would hand real winners more than R, inject `X` on
  the winning side at `T − lead_ms` so that `Pot × S_rw / (S_rw + S_sw + score(X)) = R`.
  Closed form with early-bonus 0: `X = V_sl × S_rw / R − S_sw` (the directive's formula with `Pot`, `V_real_loss`
  read as net values). Implemented by bisection on the real score function so the impact term is exact.
* **Ghost Town (Defense C)**: all real users on one side → at `T − lead_ms` inject on the opposite side so it
  leads by `ghost_town_margin_pct`; the simulator wins, company keeps commission + unpaid R (no real winners).
* **Continuous steering (Defense A)**: organic NPC flow leans (probabilistically, strength configurable) to the
  side that lowers projected exposure. Cosmetic — the final injection is the guarantee.
* **Lock**: the engine sets `tt:battle:lock:{id}` then executes the final injection; the API rejects every
  later real order with `ROUND_LOCKED`; the engine's settlement grace key is held during the injection so
  settlement cannot start before it lands.
* **Organic flow**: no reaction sized to real trades. Round start: 1–5 NPCs (peak 10–20) trickle in over a
  random 1–15 s window; arrivals then follow a Poisson process whose rate ramps to a peak; tiers (Whale / Mid /
  Retail) with admin Min/Max stakes; per-round lead side + target share (60–90 %) held for the first 80–90 % of
  the round; no pool-parity logic at all.
* **Winner rule**: pot dominance only (the hidden house rule becomes an explicit off-by-default setting).

## 3. Architecture (as implemented)

```
admin UI (NPC Simulator → Organic Engine) ──PUT /admin/npc/organic/settings──▶ API (AdminNpcOrganicService)
        schema-driven form from GET …/schema          │ validate (shared ORGANIC_FIELD_SPECS), version++
                                                      │ system_settings.npc_organic_settings (JSON doc)
                                                      │ SET ticktrade:npc:organic:settings, ticktrade:npc:engine_mode
                                                      │ PUBLISH engine:events:npc.organic.settings {document, mode}
                                                      ▼
   npc-worker (default) or engine leader: NpcEngineSwitch → OrganicNpcEngine | legacy NpcSimulatorService
        ├─ OrganicSettingsSource   push → apply now; 20 s poll; DB fallback on boot
        ├─ RoundSession            spawn plan, Poisson arrivals, tiers, lead target, quiet periods, boost
        ├─ RoundExposureReader     stakes + NPC trades + pots + price path → DirectiveRoundInput
        ├─ projection every 5 s    planFinalInjection + steeringSideFor (Defense A)
        ├─ final injection         T − lead: grace key → lock key → battle.locked → drain → slices (whales)
        └─ RoundAuditStore         npc_round_audit row + Redis live view (1 s) + engine status heartbeat
   API hot path: readNpcEngineModeFromRedis (2 s cache) → organic ⇒ no hedge / dominance / async dominance;
                 lock key ⇒ ROUND_LOCKED (fast validation, full validation, in-transaction recheck)
   Settlement:   BattleSettlementService → applyDirectiveSettlement when npc_round_audit.mode = organic
   WS:           engine:events:battle.locked → battleLocked to the battle room; snapshot carries locked + trader_count
```

Mode `npc_engine_mode` (`organic` default | `legacy`) is live-switchable; `NpcEngineSwitch` stops one engine and
starts the other. In organic mode the worker listener ignores reactive bursts and align-at-close, and the API's
legacy in-transaction counter-trades are skipped.

## 4. Settings (single source of truth: `packages/shared/src/npc-organic/settings.ts`)

Groups → keys (defaults). "live" applies mid-round, "next round" is read when a round opens, "settlement" at settlement.

* engine: `mode` organic (live); `houseMaxRealLoserPoolRule` false (next round; frozen at round start)
* roundStart (next round): `initialSpawnsMin` 1, `initialSpawnsMax` 5, `spawnDelayMinMs` 1000, `spawnDelayMaxMs` 15000,
  `peakInitialSpawnsMin` 10, `peakInitialSpawnsMax` 20, `peakInitialWindowMs` 15000, `peakHours` "" (e.g.
  `18:00-23:00,12:00-14:00`), `peakTimezoneOffsetMinutes` 0
* momentum (live): `baseArrivalsPerMinute` 4, `peakArrivalsPerMinute` 24, `rampToPeakFraction` 0.6,
  `lateFadeFraction` 0.95, `peakHoursMultiplier` 1.6, `realTradeBoostMultiplier` 1.5, `realTradeBoostSeconds` 20,
  `quietPeriodChancePct` 12, `quietPeriodMinSec` 4, `quietPeriodMaxSec` 12, `maxDistinctNpcsPerRound` 120,
  `maxSimVolumePerRound` 0
* tiers (live): whale `{rosterSharePct 5, tradeSharePct 10, stakeMin 5000, stakeMax 50000}`,
  mid `{25, 30, 500, 5000}`, retail `{70, 60, 10, 500}`, `sizeJitterPct` 15, `roundToLadder` true
* asymmetry (next round): `organicWindowFraction` 0.85, `leadSharePctMin` 60, `leadSharePctMax` 90,
  `leadSideMode` random | follow_real | against_real, `fomoFollowStrengthPct` 35
* defenses (live): `steeringEnabled` true, `steeringStrengthPct` 50, `steeringStartFraction` 0.2,
  `dilutionEnabled` true, `dilutionSafetyMarginPct` 2, `finalInjectionLeadMs` 150, `finalInjectionMaxSlices` 3,
  `finalInjectionMaxUsd` 0 (unlimited), `ghostTownEnabled` true, `ghostTownMarginPct` 5, `ghostTownFallbackMaxSimLossUsd` 0
* audit: `keepRounds` 50

Every field carries label, help text, unit, min/max/step and the "applies" tag; the admin page renders from the
schema served by `GET /admin/npc/organic/schema`, so the UI cannot drift from the engine. A setting without an
engine effect is not allowed in the schema (the earlier `baseLiquidityUsd` idea was dropped for that reason).

## 5. Files

shared: `npc-organic/{settings,organic-plan,directive-settlement,redis-keys,engine-mode.redis}.ts` + specs.
engine: `npc-organic/{organic-npc-engine,organic-settings.source,round-exposure.reader,round-audit.store,
create-organic-engine,npc-engine-switch}.ts` + spec; `battle/directive-settlement.applier.ts`;
`battle-settlement.service.ts` (mode-aware); `battle-snapshot.publisher.ts` (trader_count, locked);
`npc/npc-simulator.service.ts` (`executeOrganicNpcTrade`); `npc/npc.command.listener.ts`, `redis/redis.subscriber.ts`,
`index.ts` (routing). npc-worker: host + listener routing by mode, tsconfig include. api:
`admin/npc/admin-npc-organic.{controller,service}.ts`, lock checks in `trades.service.ts` +
`trade-fast-validation.service.ts`, `redis/redis.subscriber.ts` (battleLocked), `admin.module.ts`.
prisma: `NpcRoundAudit` model + migration `20260913120000_add_npc_round_audit`. docs: `docs/NPC-ORGANIC-ENGINE.md`.
admin: `NpcOrganicEngine.jsx` (+ `npcOrganicApi.js`, CSS) — tab "Organic Engine" with Settings / Live round /
Round audits; legacy-only tabs labelled. frontend: `battleLocked` → LOCKED buttons (`matchStore.roundLock`),
`tradeRejectionToast.js`, snapshot `locked` / `trader_count` in the UI signature.

## 6. Tests

shared (27): schema defaults/validation/coercion; planners (bounds, ramp, tier shares, ladder); settlement
invariants (company = fee×V_rl, sim net 0, real = R + surplus, ghost town, ties); injection solver.
engine (8): session timing with a fake clock (no trade before spawnDelayMin, initial count in bounds, arrivals,
lock + injection at end − lead, boost on real trade, settings push). Workbench: `tools/npc-organic-smoke.cjs`
(live round with one real trader, LOCKED buttons, ROUND_LOCKED, audit invariants, admin form round-trip).
Baseline: 13 pre-existing engine spec failures (pricing + legacy protection) are unchanged.
