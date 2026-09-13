# TickTrade Workbench

A sandbox copy of the whole TickTrade stack — backend (NestJS API, engine, settlement + NPC workers, Postgres, Redis), the trading PWA and the admin app — that Claude installs, runs, changes, tests and monitors. Every change lands as a git commit in `backend/`, `admin/` or `frontend/`, and the **Live Monitor** artifact shows the effect.

```
wb/
├─ backend/    ASPR-backend-             (git, branch dev, baseline = developer drop 2026-09-12)
├─ admin/      APSR-admin-               (git)
├─ frontend/   Tick-Trade-project-APSR   (git)
├─ tools/      wb.sh · probe.mjs · split-snapshot.mjs · fixtures.cjs · static-server.cjs
├─ monitor/    index.html  (the Live Monitor page; db-backed artifact)
├─ patches/    unified diffs of every change, per commit
├─ env/        backend.env (generated, local-only synthetic secrets; never commit)
├─ run/        pids, logs, test logs
├─ snapshots/  probe output (latest.json + db/ split documents)
└─ changes.json  change log shown on the monitor
```

## Daily loop

| Step | Command |
|---|---|
| Bring everything up | `wb setup` (first time) — later `wb start` |
| See what is running | `wb status` · `wb ports` · `wb logs api 200` |
| Rebuild after a change | `wb build backend` / `wb build frontend` / `wb build admin`, then `wb restart api engine …` |
| Run tests | `wb test` (api · engine · shared · admin-regression) |
| Refresh the Live Monitor | `wb probe` → `node tools/split-snapshot.mjs` → Claude pushes the documents with the Artifact `write_db` batch |
| Reset the synthetic database | `wb db:reset` |

Local URLs: trading app `http://127.0.0.1:18771`, admin `http://127.0.0.1:18772`, API `http://127.0.0.1:18773` (Swagger at `/docs`). Logins are the generated `SEED_ADMIN_*` / `SEED_DEMO_*` values in `env/backend.env` (synthetic, local only).

## Requirements

Node 22, pnpm 10, PostgreSQL 16, Redis 7, Playwright + Chromium (for browser checks), and **network access to the package registries** (`registry.npmjs.org`, `binaries.prisma.sh`). In a Claude cloud environment that means *Network access = Trusted* (or Custom + "include default package managers").

## Recreating the workbench in a fresh cloud session

1. Upload the three repo ZIPs (or connect GitHub so they can be cloned) and this `ticktrade-workbench.zip`.
2. Run `bash bootstrap.sh` from the extracted workbench — it unpacks the repos into `wb/`, re-applies every commit in `patches/`, then runs `wb setup`.
3. Claude re-publishes the monitor (same artifact URL) and pushes a fresh snapshot.

To make step 2 automatic and cached, paste `cloud-environment-setup.sh` into the environment's **Setup script** field; with GitHub connected it clones the repos and pre-installs dependencies once, and later sessions start from that snapshot.

## Change contract

Each change = one git commit + one entry in `changes.json` (`id`, `at`, `title`, `repo`, `files`, `status`: proposed → applied → verified, `tests`, `notes`) + a diff in `patches/`. The diff is what you apply to your real repository; the same change is also exported in the local tool's "Returned JSON changes" format when useful.
