# TickTrade Studio — round 10 (2026-09-19)

Three source ZIPs: `ASPR-backend-`, `APSR-admin-`, `Tick-Trade-project-APSR`.
No `node_modules`, `dist`, `.env` or logs. Only `.env.example` ships.

---

## 1. What this round actually is

The uploaded `backend--opus-round9` and `admin--opus-round9` contain **no Creator
Platform code at all** — no `apps/api/src/creator/`, no `packages/tickscript/`,
no admin Creator page. Studio v5 and round 9 are two branches off the same
12 Sep 2026 developer drop that were never merged.

So this round is a **port of Studio onto the round-9 line**, not a fix-up of an
existing integration.

Of the 217 backend files that differ between the v5 tree and round 9 outside
`creator/`, **none are creator-related** — they are round-9 upstream work and were
all kept unchanged.

Frontend: per your instruction, the base is the frontend supplied in the v5
bundle, used as-is. See "Known gaps" for what that excludes.

## 2. Exact modified-file scope

### Backend — 44 files added, 4 modified
Added: `apps/api/src/creator/` (24), `packages/tickscript/` (14),
4 Prisma migrations (`creator_platform`, `creator_platform_v2`,
`creator_order_link`, `creator_discovery_index`).

Modified (the whole integration seam):
| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | import + register `CreatorModule` (2 lines) |
| `apps/api/package.json` | add `@ticktrade/tickscript` workspace dep (1 line) |
| `packages/shared/prisma/schema.prisma` | 17 `Creator*` models + 2 `User` relation fields |
| `pnpm-lock.yaml` | regenerated for the new workspace package |

`schema.prisma` is CRLF in round 9 and LF in v5; the appended block keeps the
file's existing CRLF so your recorded `git am --keep-cr` patches still apply.

### Backend — fixes on top of the port
| File | Change |
|---|---|
| `packages/tickscript/intelligence-utils.cjs` | `sd()` no longer recomputes `mean()` per element |
| `packages/tickscript/intelligence-measured.cjs` | same hoist; event bucketing replaces a per-row scan |
| `packages/tickscript/intelligence-engine.cjs` | percentile cohorts/ladders built once; null fields get a reason |
| `packages/tickscript/index.cjs` | supervisor deadline is CPU-aware |
| `apps/api/src/creator/creator-intelligence.service.ts` | `hydrate()` explains every unavailable field |

### Admin — 2 files added, 1 modified
Added `src/Pages/AdminDashboard/CreatorPlatform.jsx` and `.css`.
Modified `src/Pages/AdminDashboard/index.jsx`: 4 lines (import, `menuGroups`
single entry gated on `creator.view`, `allMenuItems` entry, `activeTab` branch).

`creator.view` is seeded with `groupId NULL` deliberately — `admin-menu.service`
treats a NULL-group menu entry as a top-level single, matching `isSingle: true`.

### Frontend — unchanged from the v5 bundle you supplied.

## 3. Setup

Requires PostgreSQL 16 + Redis. The workbench uses a **native** cluster, not a
container, so the 512 MiB limit that crashed the previous round does not apply
and the 1 GiB Docker override is not needed. If you keep Docker, give PostgreSQL
at least 1 GiB.

```
pnpm install --config.symlink=true        # backend (lockfile updated: new workspace pkg)
pnpm run prisma:generate
cd packages/shared && npx prisma migrate deploy
npm ci                                     # frontend and admin
```

The 4 creator migrations interleave correctly with round 9's
`20260918090000_ledger_stake_reference_unique` and `20260919120000_missing_permission_keys`.
**Never reset the database** — these are additive.

## 4. Test results — what actually ran

All of this ran against a live stack (PostgreSQL 16 + Redis + API + engine +
workers + built frontend/admin) with the trading engine producing real rounds.

| Suite | Result |
|---|---|
| `packages/tickscript` runtime/contract | **25/25** idle, **25/25** under CPU saturation |
| `apps/api` jest | **57 suites / 319 tests** |
| Prisma migrate deploy | all applied, **zero schema drift** |
| Builds | backend, frontend, admin all clean |
| Creator lifecycle (live HTTP) | **13/13** |
| DataBank under load (live HTTP) | **8/8** |
| One-card-per-page, desktop + real phone touch swipe | **11/11** with 8 indicators |
| Eight-indicator load (real browser) | **9/9** |
| Round transition | observed live, recovered |

### Measured numbers
- DataBank cold build, 400 traders / 4,800 accepted orders: **844–1,118 ms, 388 KiB**
- Repeat build (cached): **11–13 ms** (~86× faster)
- 6 concurrent builds of one round: **799–849 ms total** (in-flight sharing works)
- Profile switching: **3 / 4 / 10 ms** (min/median/max over 12 switches)
- DataBank export: **36–40 ms, 2.06 MiB**
- Eight indicators: install 172 ms each, warmup 10.3 s for all 8, feed **30/35/38 ms**
  at 342 KiB, two-rAF turnaround **35 ms**, JS heap **18 → 21 MiB** over 15 s of live ticks
- `/creator/*` unauthenticated returns **401, not 404** — the mixed-deployment
  "Cannot GET /creator/intelligence" failure class is gone

### DataBank parity — counted, not quoted
Counted at runtime, not read from documentation:
**20 sections**, **200 field definitions**, **76 measured fields per trader**.
On the live dataset, 90 of the 200 fields were unavailable; each keeps its full
definition (`key`, `label`, `unit`, `provenance`, `formula`, `requiresProfile`)
with `value: null`, `source: "unavailable"` and an explicit `reason`.

### Product behaviour verified in a real browser
- "Apply · save privately" saves to the library and **does not** attach or publish
- Attaching happens only via an explicit install from the Indicators explorer
- Live expert execution is refused: *"Live experts must be enabled in server
  configuration and Creator admin settings"*
- X hides a surface; hiding both auto-stops the run; a stopped run can be removed;
  **the saved source survives removal**
- Phone: one card per native horizontal swipe page, 12 pages with 8 installed,
  all 4 original built-in pages preserved, no grid and no in-card dropdown
- Desktop navigation reaches those same pages
- Indicators survived a real round transition (round 5 → cooldown → round 6),
  all 8 back to `running` within 1.4 s with errors cleared

## 5. Fixes in this round (all measured, none cosmetic)

**a. DataBank was quadratic — 21× faster, byte-identical output.**
`sd()` called `mean(v)` from inside `v.map(...)`, so an O(n) reduce ran once per
element; and `enrich()` re-scanned all events per trader.

| total events | before | after | |
|---|---|---|---|
| 10,000 | 79 ms | 18 ms | 4.4× |
| 160,000 | 3,634 ms | 310 ms | 11.7× |
| 640,000 | 25,796 ms | 1,223 ms | **21.1×** |

Cost is now linear in total events. `JSON.stringify(enrich(...))` matches the
previous implementation exactly on every shape tried, including 0 and 1 events
per trader and deliberately interleaved event ordering.

**b. Six DataBank fields shipped as a bare null with no explanation.**
The 10 `benchmark.*` percentiles are not in the catalog's dependency map, so
`hydrate()` could never derive a reason for them. Fields resolving to null now
state why and are marked unavailable rather than presented as observations.
Verified over 4 rounds × 8 profiles: **200 reasons added, 200 sources corrected,
zero computed values changed.** Unavailable-with-a-reason went 84/90 → **90/90**.

**c. Percentile ranking was O(records² × specs)** — 3,200 sorts of a 400-element
array per build. Cohorts and ladders are built once and ranked by binary search
on the same formula. Percentiles are bit-identical.

**d. A healthy script could be killed by the supervisor's wall-clock deadline.**
The guest charges its own 80 ms budget in CPU time, so throttling cannot fail a
script there — but the parent's 8 s deadline was pure wall clock and SIGKILLed the
**shared** worker, discarding every other script queued on that pool.

Reproduced deterministically: 6 spinners on 4 CPUs took the runtime suite to
24/25, failing at exactly 8008 ms with *"Script exceeded its execution deadline"*.
Measured cause: exhausting the 16 MiB guest limit needs ~7 s of CPU (6.35 s wall
at 112% of a core when idle), so the 8 s backstop had almost no margin.

The deadline now reads the child's real CPU from `/proc/<pid>/stat` and grants at
most 2 extra periods when the child got less than 0.9 of a core. A script burning
CPU never qualifies. Under saturation one extension is granted and the memory bomb
then stops on the **correct inner limit** (`out of memory`) at 11.1 s. A pure CPU
spin on an idle box is still caught by the guest's 80 ms interrupt in 634 ms and
never reaches the supervisor.

## 6. Known gaps and unverified behaviour

- **The frontend base is the v5 bundle, as you chose.** It therefore does not
  include frontend workbench patches 0006 (round lock state / server rejection
  toasts) and 0007 (continuous chart series, local countdown, pool-bar labels,
  estimator throttle). I verified those replay cleanly onto the 12 Sep baseline
  and that Studio merges onto them with exactly one conflicting file
  (`src/components/NewChart.jsx`, 5 hunks, both sides having independently
  improved the same canvas/DPR code). Say the word and I'll do that merge.
- **Expert execution beyond the refusal path is untested.** Live experts are
  disabled by server config here, so I verified the gate, not live/paper expert
  behaviour end to end.
- **PWA install/update was not driven.** The service worker builds (13 precache
  entries, 209 KiB) but I did not exercise an install→update→"Update now" cycle.
- **No long-duration endurance run.** Longest continuous observation was ~7 minutes
  across one round transition. Multi-hour memory/stability is still unverified.
- **DataBank load used synthetic stakes.** The engine produced real rounds and real
  NPC trades, but `stakes` was 0, so the DataBank honestly reported 0 profiles. To
  load-test it I seeded **400 synthetic traders and 19,200 stakes** directly into
  the isolated local database, tagged `qa-bank-%@synthetic.local`. Remove with:
  `DELETE FROM stakes WHERE "userId" IN (SELECT id FROM users WHERE email LIKE 'qa-bank-%@synthetic.local'); DELETE FROM users WHERE email LIKE 'qa-bank-%@synthetic.local';`
  This is a **synthetic** test, clearly distinct from the native-engine tests above.
- **The supervisor extension raises the worst case** on a contended box from 8 s to
  24 s for a script that escapes the guest CPU interrupt through native
  allocation/GC work. That is a deliberate trade against tearing down a shared
  worker; the idle-box ceiling is unchanged.
- **`wb stop` does not stop services.** `wb.sh` writes the wrapper shell's PID, not
  the node process, so stop/restart silently no-op. This bit me mid-session and
  cost a wrong measurement. Not fixed — it is workbench tooling, outside this scope.
- **Cosmetic, not fixed:** with panes attached, the chart's "Time left" label can
  overlap the price-axis label at the top right.
- **Monaco is heavy.** The Studio editor chunk is 3.16 MB (817 KB gzip) plus 737 KB
  for `tsMode`. It is lazily loaded so it only costs on `/studio`, but on a phone
  that is a real download.
- **No claim of zero bugs.** Untouched areas: NPC/simulator, RPC, pricing,
  settlement, wallets, native trading rules, marketing, other admin modules.
