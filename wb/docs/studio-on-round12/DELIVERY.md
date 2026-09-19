# TickTrade Studio on your latest app (2026-09-19)

Three source ZIPs, built on the versions you just sent:

| ZIP | Base you uploaded |
|---|---|
| `ASPR-backend--studio-on-round12` | backend--opus-round12 |
| `APSR-admin--studio-on-round12` | admin--opus-round12 |
| `Tick-Trade-project-APSR--studio-on-round11` | frontend--opus-round11 |

No `node_modules`, `dist`, `.env` or logs. Only `.env.example` ships.

---

## 1. What was done

Your round-12 backend, round-12 admin and round-11 frontend contain no Creator
Platform code, exactly as you said. Studio has been ported into them.

**Backend and admin were a verbatim re-apply.** The three backend seam files
(`app.module.ts`, `apps/api/package.json`, `schema.prisma`) and the admin's
`AdminDashboard/index.jsx` are **byte-identical between round 9 and round 12**, so
the port applied unchanged. None of round 12's 19 changed or 5 new files touch the
seam — its work (db-restart util, transient infra errors, NPC settings presets,
ops health, execution guards) is untouched.

**The frontend needed a real merge**, because round 11 is a different line from the
one Studio was previously merged onto. Merge base was the 12 Sep 2026 developer
drop. Two conflicts, both resolved in **round 11's favour**, because round 11 is
newer and carries explicit owner decisions Studio has no stake in:

- `src/live/services/tradeRejectionToast.js` — round 11 rewrites the round-close copy
  ("That round closed just before your order reached us — it was not placed, and your
  balance is unchanged") and folds `ROUND_LOCKED`, `BATTLE_FROZEN` and `ORDER_FREEZE`
  into one message. Kept verbatim.
- `src/components/TradingPanel.jsx` — round 11 deliberately reverses the earlier
  round-lock behaviour: the buttons never say LOCKED and never go dark for a
  server-side lock, only when the round is genuinely over. Kept; the older
  `roundLocked` gating was dropped.

`Matches.jsx` loses its hardcoded four-slide swipe (`activeSlide < 3`) in favour of
the creator card pager. That is the integration, not a regression: the pager keeps
those same four built-in pages and adds one page per installed indicator — verified
in a real browser below.

Net frontend change vs round 11: 49 files, +12,278 / −66, essentially all creator
additions.

## 2. Exact modified-file scope

### Backend — 44 files added, 4 modified
Added: `apps/api/src/creator/` (24), `packages/tickscript/` (14), 4 Prisma migrations.

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | import + register `CreatorModule` (2 lines) |
| `apps/api/package.json` | add `@ticktrade/tickscript` workspace dep (1 line) |
| `packages/shared/prisma/schema.prisma` | 17 `Creator*` models + 2 `User` relation fields, appended with the file's existing **CRLF** endings so your recorded patches still apply |
| `pnpm-lock.yaml` | regenerated for the new workspace package |

### Admin — 2 files added, 1 modified
`CreatorPlatform.jsx` / `.css`, plus 4 lines in `AdminDashboard/index.jsx`
(import, `menuGroups` single entry gated on `creator.view`, `allMenuItems` entry,
`activeTab` branch). `creator.view` is seeded with `groupId NULL` on purpose —
`admin-menu.service` treats a NULL-group entry as a top-level single.

### Frontend — 33 creator files + the integration merge above.

## 3. Setup

Native PostgreSQL 16 + Redis (no container memory cap, so the 512 MiB crash does not
apply). If you keep Docker, give PostgreSQL at least 1 GiB.

```
pnpm install --config.symlink=true        # backend; lockfile updated for the new package
pnpm run prisma:generate
cd packages/shared && npx prisma migrate deploy
npm ci                                     # frontend and admin
```

The 4 creator migrations interleave correctly with round 12's set — 98 migrations,
no pending, **zero schema drift**. They are additive; never reset the database.

**Build the web apps with `NODE_ENV` unset.** `env/backend.env` sets
`NODE_ENV=development` for the API; if that is exported when Vite runs,
`import.meta.env.PROD` is false and the build silently drops the PWA registration —
no service worker, no precache, no "Update now" prompt — while still exiting 0.
`wb build` now unsets it.

## 4. Test results on the versions you sent

Against a live stack (PostgreSQL 16 + Redis + API + engine + workers + built
frontend/admin) with the trading engine producing real rounds.

| Suite | Result |
|---|---|
| `packages/tickscript` runtime/contract | **25/25** idle, **25/25** under CPU saturation |
| `apps/api` jest | **58 suites / 335 tests** |
| frontend unit (`node --test`) | **32/32** |
| Prisma migrate deploy | applied, **zero schema drift** |
| Builds | backend, frontend, admin all clean |
| Creator lifecycle (live HTTP) | **13/13** |
| DataBank under load | **8/8** |
| Paper expert execution | **10/10** |
| PWA against the real service worker | **6/6** |
| One card per page, desktop + real phone touch swipe | **11/11** with 8 indicators |
| Eight-indicator load (real browser) | **9/9** |
| Round transition | rounds 26 → 27, all 8 recovered |
| **Endurance, 30 min with 8 indicators** | **120/120 feed polls OK, 0 failures** |

### Measured
- Eight indicators: feed **29/30/36 ms** at 357 KiB, two-rAF turnaround **31 ms**,
  JS heap **15 → 16 MiB** over 15 s of live ticks
- DataBank cold build over 400 traders / 4,800 accepted orders: **~0.9 s**, 388 KiB;
  cached repeat **~11 ms**; profile switching **3 / 4 / 10 ms**
- Endurance, 30 min / 8 indicators: RSS **483 → 492 MiB** (+9), feed **120/120 OK**,
  latency **31 / 39 / 48 / 58 ms** (min/median/p95/max), **5 round transitions**,
  8 indicators enabled throughout
- PWA: 13 workbox precache entries + 23 runtime, offline shell boots, a new build
  puts a worker in `waiting` so the update prompt fires
- `/creator/*` unauthenticated returns **401, not 404**

### Verified product behaviour
"Apply · save privately" saves without attaching or publishing · attaching happens
only via an explicit install from the Indicators explorer · live experts refused
("Live experts must be enabled in server configuration and Creator admin settings")
· paper experts record decisions with a reference price, **zero real stakes, balance
unchanged at 100000.00** · X hides a surface, hiding both auto-stops the run, a
stopped run can be removed, and the saved source survives · one card per native
swipe page, 12 pages with 8 installed, all 4 built-in pages preserved · desktop
navigation reaches the same pages · DataBank counted at runtime: **20 sections /
200 field definitions / 76 measured fields**, with all 90 unavailable fields
carrying an explicit reason.

## 5. Fixes carried in (all measured)

**DataBank was quadratic — 21× faster, byte-identical output.** `sd()` recomputed
`mean(v)` inside its own `map`; `enrich()` re-scanned all events per trader.
640k events: 25,796 ms → 1,223 ms, now linear.

**Six DataBank fields shipped as bare nulls with no explanation.** The 10
`benchmark.*` percentiles are not in the catalog's dependency map. Now every field
resolving to null says why. 200 reasons added, 200 sources corrected, **zero
computed values changed**.

**Percentile ranking was O(records² × specs)** — 3,200 sorts of a 400-element array
per build. Built once, ranked by binary search, bit-identical.

**A healthy script could be killed by the supervisor's wall-clock deadline.**
Reproduced under CPU saturation (24/25, failing at exactly 8008 ms). The deadline
now reads the child's real CPU and extends only when it got under 0.9 of a core.
A CPU spin is still caught by the guest's 80 ms interrupt in 634 ms.

**The private library could fill permanently.** There is a hard 50-script limit and
there was **no route to delete a saved script** — after 50 saves, "Apply · save
privately" failed forever with no recovery in the product. Added
`DELETE /creator/scripts/:id` plus a Delete button in Studio's My code dialog. It
refuses while the tool is still attached ("Stop this tool everywhere before deleting
it") and never destroys a live expert journal — both guards tested.

**Workbench tooling:** `wb stop`/`restart` never worked (the PID file recorded the
`setsid` wrapper, not the service); `wb start` hung when piped; `wb build` inherited
`NODE_ENV=development`; and `static-server.cjs` always replaced `sw.js` with a
network-only stub, so the PWA could not be verified at all (`WB_REAL_SW=1` now
serves the real one).

## 6. Remaining gaps and unverified behaviour

- **Round 11's PWA precache is 13 entries**, narrower than the arena-path precache on
  the other frontend line. That is round 11's own `vite.config.js`; I did not widen
  your PWA configuration. Offline boot and the update prompt both work as configured.
- **Live expert execution is untested beyond the refusal path.** Live is disabled by
  server config here, so the gate is verified, not live execution.
- **Endurance is now measured, not pending.** A 30-minute run with 8 active indicators
  completed: 120 samples, **RSS 483 → 492 MiB (max 493, +9 MiB over 30 minutes)**, feed
  **120/120 OK with 0 failures** at min/median/p95/max **31 / 39 / 48 / 58 ms**, rounds
  27 → 32 across **5 round transitions**, and installations never dropped below 8
  enabled. No leak and no degradation over the window. **Multi-hour stability is still
  unverified** — 30 minutes is the longest run.
- **DataBank load used synthetic stakes.** The engine produced real rounds and real NPC
  trades, but `stakes` was 0, so the DataBank honestly reported 0 profiles. To load-test
  it I seeded 400 synthetic traders and 19,200 stakes into the isolated local database,
  tagged `qa-bank-%@synthetic.local`. Remove with:
  `DELETE FROM stakes WHERE "userId" IN (SELECT id FROM users WHERE email LIKE 'qa-bank-%@synthetic.local'); DELETE FROM users WHERE email LIKE 'qa-bank-%@synthetic.local';`
  Clearly a **synthetic** test, distinct from the native-engine tests.
- **The supervisor extension raises the worst case** on a contended box from 8 s to 24 s
  for a script that escapes the guest CPU interrupt through native allocation/GC work.
  The idle-box ceiling is unchanged.
- **Monaco is heavy** (3.1 MB editor chunk). Verified to load **only** on `/studio` —
  never on the trading screen or the Indicators explorer.
- **No claim of zero bugs.** Untouched: NPC/simulator, RPC, pricing, settlement,
  wallets, native trading rules, marketing, other admin modules.
