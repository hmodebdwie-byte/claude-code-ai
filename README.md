# TickTrade Workbench

Everything needed to recreate, run, change and test the TickTrade stack (backend API + engine + workers, the trading PWA and the admin app) inside a Claude cloud session lives under [`wb/`](wb/README.md).

- `wb/bootstrap.sh` — recreates the workbench: clones (or unpacks) the three product repos on branch `dev`, re-applies every recorded patch, then runs `wb setup`.
- `wb/tools/wb.sh` — the `wb` CLI: install, env, migrate, seed, build, start/stop, status, test, probe.
- `wb/tools/browser-smoke.cjs` — logs into the trading app and the admin in headless Chromium and exercises the patched flows.
- `wb/patches/` — `git format-patch` files for every change applied on top of the developer's 12 Sep 2026 drop.
- `wb/changes.json` — the change log shown on the Live Monitor artifact.
- `wb/monitor/index.html` — the Live Monitor page (db-backed artifact); `wb probe` + `tools/split-snapshot.mjs` produce the documents it reads.
- `wb/cloud-environment-setup.sh` — paste into the cloud environment's *Setup script* so later sessions start with the repos cloned and dependencies installed.

The product repositories themselves (`hmodebdwie-byte/ASPR-backend-`, `hmodebdwie-byte/APSR-admin-`, `hmodebdwie-byte/Tick-Trade-project-APSR`) are not vendored here; they are cloned at bootstrap time.
