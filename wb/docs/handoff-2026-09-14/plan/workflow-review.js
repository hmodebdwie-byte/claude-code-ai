export const meta = {
  name: 'ticktrade-stabilise-review',
  description: 'Adversarial review of every uncommitted change in the three TickTrade repos: lens finders, 3-vote verification, per-repo fixes, loop until dry',
  phases: [
    { title: 'Find', detail: 'six lenses per repo over git diff HEAD' },
    { title: 'Verify', detail: 'three independent refuters per finding' },
    { title: 'Fix', detail: 'one fixer per repo, then build+test' },
  ],
}

const PLAN = '/tmp/claude-0/-home-user-claude-code-ai/3fca6365-3703-5cca-b8ec-160541ae1940/scratchpad/fix-plan.md'
const REPOS = args.repos // [{ name, path, buildCmd, testCmd }]
const CONTEXT = args.context || ''

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          failure_scenario: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'category', 'claim', 'evidence', 'failure_scenario', 'suggested_fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    corrected_claim: { type: 'string' },
  },
  required: ['real', 'confidence', 'reasoning', 'corrected_claim'],
}

const FIXREPORT = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
    files_changed: { type: 'array', items: { type: 'string' } },
    build_and_tests: { type: 'string' },
    notes_for_pdf: { type: 'string' },
  },
  required: ['fixed', 'skipped', 'files_changed', 'build_and_tests', 'notes_for_pdf'],
}

const LENSES = [
  { key: 'finance', prompt: 'FINANCE SAFETY: any path where user balance, stakes, pots, payouts, refunds, idempotency, settlement or NPC balances could be wrong, double-applied, lost, clamped, or raced (Lua atomicity, MULTI, ordering, negative values, rollback, crash windows).' },
  { key: 'regression', prompt: 'BEHAVIOUR REGRESSION: a previously working feature that this diff breaks — removed handlers/events still emitted or expected elsewhere (grep the other repos for the event names and function names), changed payload shapes without updating consumers, removed sessionStorage/resume features that other code still calls, admin pages reading fields that no longer exist, tests that now assert stale behaviour.' },
  { key: 'concurrency', prompt: 'CONCURRENCY / STABILITY: unhandled promise rejections, timers not cleared, intervals that pile up, in-flight guards missing, leader/lease logic that can double-run or never run, Redis connection misuse, memory growth, retry loops without bounds, ordering of stop()/enqueue/publish.' },
  { key: 'determinism', prompt: 'CROSS-DEVICE DETERMINISM AND CHART CORRECTNESS: any way two clients could still render different bars or the cursor/entry line could misbehave — dedupe keys, replace-vs-merge on candleBatch, timestamp units (s vs ms), flat candle emission during cooldown, battle_id null handling, barSpacing/rightOffset math, autoscale providers, RAF loop restart conditions, visibility handling, in-progress bar volume.' },
  { key: 'contracts', prompt: 'CONTRACT CONSISTENCY across repos: compare every socket/REST payload produced by the backend diff with what the frontend/admin diffs consume (field names, units, null cases, events emitted on connect vs subscribe, timerUpdate on subscribe, range in payload, status fields desired_active_source/recent_trades/rotation_starved, rotation keys). Read the plan contracts C1–C4 and flag any deviation.' },
  { key: 'quality', prompt: 'CODE QUALITY THAT WILL BITE: TypeScript any-casts hiding real type errors, CRLF/LF mixing in backend files (run `file` on changed backend files), console noise on hot paths, O(n^2) on per-tick paths, missing env defaults, dead code left behind, eslint errors, misleading comments/help text after the change.' },
]

phase('Find')
const jobs = []
for (const repo of REPOS) for (const lens of LENSES) jobs.push({ repo, lens })
const found = await parallel(jobs.map(({ repo, lens }) => () => agent(
`You are a skeptical senior reviewer. Repo: ${repo.name} at ${repo.path}. The working tree holds UNCOMMITTED changes from a stabilisation effort (see ${PLAN} for the intended design; contracts C1–C4 are binding). Context: ${CONTEXT}
List the change set with \`cd ${repo.path} && git status --short && git diff HEAD --stat\`; read the full diff (\`git diff HEAD\`; new untracked files must be read whole). The other repos are at ${REPOS.map(r => r.name + '=' + r.path).join(', ')} — read them when a claim depends on a consumer/producer there.
Your single lens: ${lens.prompt}
Report only defects you can point to with file and line in the NEW code (or a missing change that the plan requires), each with a concrete failure scenario. No style nits, no hypotheticals without a path to failure. If you find nothing under this lens, return an empty list.`,
  { label: `find:${repo.name}:${lens.key}`, phase: 'Find', schema: FINDINGS, effort: 'high' })))

const all = found.filter(Boolean).flatMap((r, i) => (r.findings || []).map(f => ({ ...f, repo: jobs[i].repo.name, repoPath: jobs[i].repo.path, lens: jobs[i].lens.key })))
const seen = new Set()
const unique = all.filter(f => { const k = `${f.repo}|${f.file}|${f.title.toLowerCase().slice(0, 60)}`; if (seen.has(k)) return false; seen.add(k); return true })
log(`found ${all.length} raw findings, ${unique.length} after dedupe`)

phase('Verify')
const verified = await pipeline(unique,
  f => parallel([
    'correctness (read the code paths end to end and decide whether the claimed failure can actually happen)',
    'reproduction (write and run a small node script or test against the code if feasible; otherwise trace concrete values through the code)',
    'blast radius (assume it is real: is the effect user-visible or money-affecting, or is it benign / already mitigated elsewhere in the diff?)',
  ].map((lens, i) => () => agent(
`Adversarially verify this review finding. Default to real=false unless the evidence holds up. Lens: ${lens}.
Repo ${f.repo} at ${f.repoPath} (uncommitted working tree; use git diff HEAD for context). Plan: ${PLAN}.
Finding: ${JSON.stringify(f, null, 1)}
Return real=true only if the failure scenario is achievable in the new code as written (for the blast-radius lens: real=true means the effect matters — user-visible or money/state affecting).`,
    { label: `verify${i + 1}:${f.repo}:${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
    .then(votes => {
      const vs = votes.filter(Boolean)
      const real = vs.filter(v => v.real).length >= 2
      return { ...f, votes: vs, real }
    })
)
const confirmed = verified.filter(Boolean).filter(v => v.real)
log(`confirmed ${confirmed.length}/${unique.length} findings`)

phase('Fix')
const fixes = await parallel(REPOS.map(repo => () => {
  const mine = confirmed.filter(f => f.repo === repo.name)
  if (!mine.length) return Promise.resolve({ fixed: [], skipped: [], files_changed: [], build_and_tests: 'no confirmed findings for ' + repo.name, notes_for_pdf: '' })
  return agent(
`You are the fixer for repo ${repo.name} at ${repo.path} (uncommitted working tree from a stabilisation effort; plan and binding contracts: ${PLAN}). Fix every confirmed review finding below in this repo. Keep fixes minimal and consistent with the plan; when a finding conflicts with the plan, follow the plan and explain. Add or update regression tests for money/state findings. Backend files are CRLF — keep them so (use the patch helper described in the plan or python; verify with \`file\`). Do not restart services.
Findings: ${JSON.stringify(mine.map(f => ({ title: f.title, file: f.file, line: f.line, severity: f.severity, claim: f.claim, evidence: f.evidence, failure_scenario: f.failure_scenario, suggested_fix: f.suggested_fix, verifier_notes: f.votes.map(v => v.corrected_claim || v.reasoning) })), null, 1)}
When done run: ${repo.buildCmd} and ${repo.testCmd}; fix what breaks. Report precisely.`,
    { label: `fix:${repo.name}`, phase: 'Fix', schema: FIXREPORT, effort: 'xhigh' })
}))

return { raw: all.length, unique: unique.length, confirmed: confirmed.map(f => ({ repo: f.repo, file: f.file, line: f.line, severity: f.severity, title: f.title, claim: f.claim })), rejected: verified.filter(Boolean).filter(v => !v.real).map(f => ({ repo: f.repo, title: f.title, why: f.votes.map(v => v.reasoning.slice(0, 200)) })), fixes: fixes.filter(Boolean) }
