# Verification harnesses (round 10)

These are the harnesses whose results are quoted in DELIVERY.md. They run against
a live stack, not mocks.

Prerequisites: API on 127.0.0.1:18773, frontend on :18771, admin on :18772,
PostgreSQL + Redis up, and a seeded demo account.

    export DEMO_EMAIL=... DEMO_PASSWORD=...        # the seeded demo user
    export SHOTDIR=/tmp                            # where screenshots land
    node creator-lifecycle.cjs                     # 13 checks, HTTP only
    node databank-load.cjs                         # 8 checks; ROUND=<id> to pin a round
    node round-transition.cjs                      # watches a real round change (up to 7 min)

Browser harnesses need Playwright and use the pre-installed Chromium:

    npm i playwright && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      node browser-one-card-per-page.cjs           # 11 checks, desktop + real CDP touch swipe
    node browser-eight-indicators.cjs              # 9 checks, install 8 and measure
    node browser-studio-explorer.cjs               # Studio and Indicators explorer

Notes:
- `creator-lifecycle.cjs` clears installations first because it asserts on
  absolute counts. It does not delete library scripts (no such route).
- `databank-load.cjs` needs a settled round that actually has stakes; pass
  `ROUND=<id>` or it picks the newest settled round, which may be empty.
- The card harnesses derive expected page counts from what is installed, so they
  work with any number of attached indicators.

Screenshots: `phone-card.png` (3 indicators), `phone-eight.png` (8 indicators),
`desktop-card.png` (desktop page navigation).
