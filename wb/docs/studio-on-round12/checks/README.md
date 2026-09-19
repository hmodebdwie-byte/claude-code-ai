# Verification harnesses

These produced the numbers in DELIVERY.md. They run against a live stack, not mocks.

Prereqs: API on :18773, frontend on :18771, admin on :18772, PostgreSQL + Redis up,
and a seeded demo account.

    export DEMO_EMAIL=... DEMO_PASSWORD=...
    export SHOTDIR=/tmp

    node api-acceptance2.cjs      # 13 checks: validate, save privately, install, X-removal, live gate
    node databank-load.cjs        # 8 checks; ROUND=<id> pins a settled round that has stakes
    node expert-paper.cjs         # 10 checks: paper expert decisions, budget, live refusal, stop-all
    node round-transition.cjs     # watches a real round change (up to 7 min)
    node endurance.cjs            # MINUTES=30 OUT=... long-running stability + API RSS

Browser harnesses need Playwright with the pre-installed Chromium:

    npm i playwright
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 node browser-cards3.cjs   # 11 checks, desktop + real CDP touch swipe
    node browser-eight.cjs        # 9 checks: install 8, measure feed/heap/responsiveness
    node browser-studio.cjs       # Studio and Indicators explorer
    APP=http://127.0.0.1:18781 DIST=<frontend>/dist node pwa.cjs # 6 checks

**PWA note.** `wb tools/static-server.cjs` normally replaces `/sw.js` with a
network-only stub so a rebuilt preview is never served from a stale precache — which
also makes the PWA untestable. Serve the real one:

    WB_REAL_SW=1 node static-server.cjs <frontend>/dist 18781

**Build note.** Build the web apps with `NODE_ENV` unset. `env/backend.env` sets
`NODE_ENV=development`; exported into a Vite build it silently strips the PWA
registration while still exiting 0.

`api-acceptance2.cjs` clears installations first because it asserts on absolute
counts. The card harnesses derive expected page counts from whatever is installed.
