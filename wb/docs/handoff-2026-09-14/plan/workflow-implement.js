export const meta = {
  name: 'ticktrade-stabilise-implement',
  description: 'Implement the chart, timer, engine, API, NPC and admin fixes in parallel (file ownership per agent), then apply the shell changes and integrate',
  phases: [
    { title: 'Implement', detail: 'seven owners edit disjoint file sets' },
    { title: 'Shell', detail: 'apply the useWebSocket.js requests from wave 1' },
    { title: 'Integrate', detail: 'build, restart, smoke, fix' },
  ],
}

const PLAN = '/tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/fix-plan.md'
const AUDIT = '/tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/audit-'

const REPORT = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, summary: { type: 'string' } }, required: ['path', 'summary'] } },
    behaviour_changes: { type: 'array', items: { type: 'string' } },
    new_settings_env: { type: 'array', items: { type: 'string' } },
    tests_added: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
    requests_for_other_agents: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string' }, file: { type: 'string' }, change: { type: 'string' } }, required: ['agent', 'file', 'change'] } },
    unfinished: { type: 'array', items: { type: 'string' } },
    notes_for_pdf: { type: 'string' },
  },
  required: ['area', 'files_changed', 'behaviour_changes', 'new_settings_env', 'tests_added', 'verification', 'requests_for_other_agents', 'unfinished', 'notes_for_pdf'],
}

const common = (letter, name, audits, extra) => `You are implementation agent ${letter} "${name}" of a seven-agent team stabilising the TickTrade trading platform (finance app: correctness first).
1. Read the plan at ${PLAN} in full — it is the spec. Your scope is section "${letter}. ${name}"; the CROSS-AGENT CONTRACTS and WAVE-1 OPERATING RULES bind you.
2. Read the audit findings for your area: ${audits.map(a => AUDIT + a + '.md').join(', ')} (exact file:line evidence and fix sketches; the plan overrides a sketch when they differ).
3. Read the code you will change before changing it. Implement EVERYTHING in your scope; if something is impossible, say so in "unfinished" with the reason. Do not touch files outside your ownership list; put cross-file needs into requests_for_other_agents with exact code.
4. Verify: type-check/build your packages, run the relevant test suites (do not regress the baselines), add regression specs for every money/state path you touched, eslint touched JS files. Runtime verification against the running stack is read-only in this wave (the stack runs the old build).
5. Return the structured report (the schema is enforced). "notes_for_pdf" must be a thorough developer-facing explanation of what was wrong, what you changed, why it is safe, and how to test it (this text goes into the delivery document for the client's dev team) — write it in plain English with file paths, 400-900 words.
${extra}`

phase('Implement')
const wave1 = await parallel([
  () => agent(common('A', 'chart-api', ['chart-data', 'pwa-shell-perf', 'api-ws-perf'],
    'Focus: contract C1 server side (continuous all-scope 1 Hz stream incl. cooldown, candleBatch replace window, memoised batch, emit-on-connect only, priceUpdate bucket_ts+volume, eventId dedupe, tradeAmount-based DB rebuild, TTLs, MAX_POINTS). Note the api-ws-perf audit item F11 (candleBatch cost) is yours too. Confirm how the boundary closer is driven today (leader load check interval?) and make sure it ticks every second even when no battle is active.'),
    { label: 'impl:chart-api', phase: 'Implement', schema: REPORT, effort: 'high' }),
  () => agent(common('B', 'chart-pwa', ['chart-motion', 'chart-data', 'pwa-shell-perf'],
    'Focus: contract C1 client side + every chart-motion finding (F1..F8) + the ROUND ENTRY autoscale + histogram scale + RAF/perf items. The user-visible acceptance criteria: (1) no vertical cliff on sign-in/resume (history arrives from the server batch); (2) two devices connected at different times render the same bars; (3) the time cursor stays where the round ended and glides right through the cooldown, no jump to the far left, no re-zoom; (4) ROUND ENTRY line never leaves the visible price range; (5) a $100k bar is always taller than a $10k bar on the same chart. lightweight-charts 5.1 API: use series.applyOptions({ autoscaleInfoProvider }), timeScale().applyOptions({ barSpacing, rightOffset }), timeScale().timeToCoordinate / logicalToCoordinate, whitespace points {time} are allowed if you ever need a gap.'),
    { label: 'impl:chart-pwa', phase: 'Implement', schema: REPORT, effort: 'high' }),
  () => agent(common('C', 'pwa-panel', ['timer-progress-pnl', 'pwa-shell-perf'],
    'Focus: contract C2 client side, pool-bar labels, Market Flip / estimate fetch loops, shell perf items, resume snapshot hygiene, vite config. Do NOT edit src/utils/useWebSocket.js (list the exact edits you need there in requests_for_other_agents, agent "pwa-shell").'),
    { label: 'impl:pwa-panel', phase: 'Implement', schema: REPORT, effort: 'high' }),
  () => agent(common('D', 'engine', ['engine-perf', 'chart-data'],
    'Focus: engine stability (serialised trade handling, finishBattle ordering + settlement watchdog + idle watchdog, leadership resilience, dedicated timer connection, unhandledRejection, heartbeat alignment), risk-terminal cost, trader count, coalescer accumulate+trailing flush, continuity price DB fallback, key TTLs. The engine test suite is `cd apps/engine && pnpm test` (node --test via ts-node; specs are *.spec.ts / *.cjs next to the code). Do not touch apps/engine/src/npc/** or apps/engine/src/npc-organic/** (agent E owns them).'),
    { label: 'impl:engine', phase: 'Implement', schema: REPORT, effort: 'xhigh' }),
  () => agent(common('E', 'npc', ['legacy-npc'],
    'IMPORTANT: an earlier attempt at exactly this scope was interrupted part-way (session limit). The backend working tree ALREADY contains its partial, uncommitted edits — run `cd /home/claude/wb/backend && git status --short && git diff HEAD -- <your files>` first, read every hunk in the files you own, keep what is correct and complete, fix what is half-done, and then finish the remaining scope. Files owned by other agents also carry uncommitted edits: leave them alone. Focus: contract C3 backend side and legacy-npc BUG-1..BUG-12, INV-5, INV-8. The legacy simulator is a 16.8k-line file — make surgical, well-commented changes; centralise NPC selection in one gate; session-per-round rotation commits; durable ON/OFF with default OFF when nothing is stored (and mirror to Redis); recent-trades ring; force-win row precedence; organic eligibility filtering. Add node --test specs for the new shared helpers.'),
    { label: 'impl:npc', phase: 'Implement', schema: REPORT, effort: 'xhigh' }),
  () => agent(common('F', 'api-core', ['api-ws-perf', 'timer-progress-pnl'],
    'IMPORTANT: an earlier attempt at exactly this scope was interrupted part-way (session limit). The backend working tree ALREADY contains its partial, uncommitted edits — run `cd /home/claude/wb/backend && git status --short && git diff HEAD -- <your files>` first, read every hunk in the files you own, keep what is correct and complete, fix what is half-done, and then finish the remaining scope. Files owned by other agents also carry uncommitted edits: leave them alone. Focus: money bugs F1/F2/F3 first (atomic pending-debit drain with a Lua script or RENAME, negative pendings applied as increments, stake+debit atomic), then F4/F5 idempotency, F6 unhandled rejections, F7 subscribe pipeline dedupe + caches + range-in-payload + timerUpdate on subscribe (contract C2), F8/T2 fan-out and the shared projection memo, F12/T3 timer relay and battleEnd ordering, F9 local emits, F13-F17, E2/E3 server side, the risk-terminal watchers key. Agent A edits the price-tick region of redis.subscriber.ts concurrently: re-read before each edit there and keep edits local.'),
    { label: 'impl:api-core', phase: 'Implement', schema: REPORT, effort: 'xhigh' }),
  () => agent(common('G', 'admin-ui', ['legacy-npc'],
    'Focus: the Organic Engine tab redesign (Battle Settings row + pencil modal + info stripe language, Market Sensitivity live card, section nav, computed previews) and the NPC Behavior / NPC Traders / Rotation tab fixes per contract C3. Reference screenshots of the design language: /home/claude/wb/run/smoke/admin-battle-settings.png, admin-market-impact-sensitivity.png, and the current organic tab admin-organic-engine.png (view them). The admin login for screenshots uses SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD from /home/claude/wb/env/backend.env via tools/admin-shot.cjs. Build must pass (`npx vite build` — workbox limit already raised). The backend fields desired_active_source/recent_trades/rotation_starved and the two new rotation keys are being added concurrently by agent E — code against the contract and degrade gracefully when they are absent.'),
    { label: 'impl:admin-ui', phase: 'Implement', schema: REPORT, effort: 'high' }),
])

const reports = wave1.filter(Boolean)
log(`wave 1 done: ${reports.length}/7 reports`)
const shellRequests = reports.flatMap(r => (r.requests_for_other_agents || []).filter(q => /useWebSocket|pwa-shell|frontend|pwa/i.test(q.agent + ' ' + q.file)))
const otherRequests = reports.flatMap(r => (r.requests_for_other_agents || []).filter(q => !/useWebSocket|pwa-shell|frontend|pwa/i.test(q.agent + ' ' + q.file)))

phase('Shell')
const shell = await agent(`You are the "pwa-shell" agent. Read ${PLAN} (sections C1, C2, WAVE 2). Apply, in /home/claude/wb/frontend/src/utils/useWebSocket.js and any small helper files it needs, the wave-2 list from the plan plus these concrete requests collected from the wave-1 agents (apply each unless it contradicts the plan; explain any you skip):
${JSON.stringify(shellRequests, null, 1)}
Also read the wave-1 reports for context (behaviour changes already made): ${JSON.stringify(reports.map(r => ({ area: r.area, behaviour_changes: r.behaviour_changes, files: r.files_changed.map(f => f.path) })), null, 1)}
Then run \`cd /home/claude/wb/frontend && npx eslint src/utils/useWebSocket.js && npx vite build\`. Return the structured report.`,
  { label: 'impl:pwa-shell', phase: 'Shell', schema: REPORT, effort: 'high' })

phase('Integrate')
const integration = await agent(`You are the integration agent. Read ${PLAN}. Wave-1/2 agents have changed the three repos (/home/claude/wb/backend, /home/claude/wb/frontend, /home/claude/wb/admin). Their reports: ${JSON.stringify([...reports, shell].filter(Boolean).map(r => ({ area: r.area, files: r.files_changed, unfinished: r.unfinished, verification: r.verification })), null, 1)}
Outstanding cross-agent requests that were NOT for the shell (apply them now if they are consistent with the plan; otherwise record why not): ${JSON.stringify(otherRequests, null, 1)}
Your job: make everything build and run together.
1. Backend: \`cd /home/claude/wb/backend && pnpm --filter @ticktrade/shared build && pnpm --filter api build && pnpm --filter engine build\` (and npc-worker / settlement-worker if they have build scripts) — fix every compile error in any file (keep the intent of the owning agent). Run \`cd packages/shared && pnpm test\` and \`cd apps/engine && pnpm test\` and any new spec files; baselines: shared 232/235 (3 pre-existing last-moment-company-hedge failures), engine 85/97 (12 pre-existing pricing/npc-simulator.protection failures). Investigate and fix any NEW failure.
2. Frontend: \`cd /home/claude/wb/frontend && npx vite build\`; admin: \`cd /home/claude/wb/admin && npx vite build\`.
3. Restart the stack: \`bash /home/user/claude-code-ai/tools/restart-backend.sh\` then \`wb start frontend admin\` if needed; \`wb status\` must show every service up and healthy. Watch logs under /home/claude/wb/run/logs (or wherever wb writes them — check \`wb status\`/the tools dir) for crashes, unhandled rejections, Prisma errors during two full rounds.
4. Smokes (all in /home/user/claude-code-ai/tools): \`node tools/chart-parity-capture.cjs 90\` (desktop + iPhone contexts must receive identical candle streams and render identical charts; inspect /home/claude/wb/run/smoke/parity-report.json and the PNGs), \`node tools/round-boundary-shots.cjs\` (wait for it; view the boundary-*.png files: the time cursor must stay at the right edge through cooldown, no far-left jump, no vertical cliff, ROUND ENTRY visible), \`node tools/admin-tools-smoke.cjs\`, \`node tools/admin-shot.cjs "User Management|NPC Simulator|ORGANIC ENGINE"\` (view the PNG). Log in to the PWA as the demo user with Playwright and place a few BUY/SELL orders (helper: /tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/impact-test.sh "buy 2000" places orders through the API) to confirm: balance debits are exact, timer never freezes, volume bars grow with notional, estimator updates within ~1 s.
5. Fix what you find (any file), re-run the affected checks, and report precisely: what passed, what failed and how you fixed it, and anything still broken.
Return the structured report; "verification" must list every command you ran with its outcome.`,
  { label: 'integrate', phase: 'Integrate', schema: REPORT, effort: 'xhigh' })

return { reports, shell, integration, otherRequests }