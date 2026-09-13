#!/usr/bin/env node
/**
 * Workbench probe — collects one JSON snapshot of the running TickTrade stack.
 *   node probe.mjs [--no-browser] [--redis-seconds=5] [--out=snapshots/latest.json]
 * Depends only on: node 22, redis-cli, psql, and the globally installed playwright.
 * Output goes to wb/snapshots/latest.json (+ a timestamped copy) and is what the Live Monitor shows.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const WB = process.env.WB_ROOT || "/home/claude/wb";
const RUN = path.join(WB, "run");
const API = "http://127.0.0.1:18773", FE = "http://127.0.0.1:18771", AD = "http://127.0.0.1:18772";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://ticktrade:ticktrade_local@127.0.0.1:5432/ticktrade_local";
const SERVICES = ["api", "engine", "engine-worker", "settlement-worker", "npc-worker", "frontend", "admin"];
const sh = (cmd, a = [], opts = {}) => { try { return execFileSync(cmd, a, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], ...opts }).trim(); } catch (e) { return null; } };
const git = (repo, a) => sh("git", ["-C", path.join(WB, repo), ...a]);
const tail = (file, n) => { try { const l = readFileSync(file, "utf8").split("\n"); return l.slice(-n - 1).filter(Boolean); } catch { return []; } };
const now = () => new Date().toISOString();
const t0 = Date.now();

// ---------------------------------------------------------------- workbench / git
const repos = {};
for (const r of ["backend", "admin", "frontend"]) {
  repos[r] = {
    commit: git(r, ["rev-parse", "--short", "HEAD"]),
    subject: git(r, ["log", "-1", "--pretty=%s"]),
    commits: Number(git(r, ["rev-list", "--count", "HEAD"]) || 0),
    dirty: (git(r, ["status", "--porcelain"]) || "").split("\n").filter(Boolean).length,
  };
}
const lastBuild = existsSync(path.join(RUN, "last-build.txt")) ? readFileSync(path.join(RUN, "last-build.txt"), "utf8").trim() : null;

// ---------------------------------------------------------------- services
const services = SERVICES.map(name => {
  const pidFile = path.join(RUN, "pids", `${name}.pid`);
  let pid = null, up = false;
  if (existsSync(pidFile)) { pid = Number(readFileSync(pidFile, "utf8").trim()); try { process.kill(pid, 0); up = true; } catch { up = false; } }
  const logFile = path.join(RUN, "logs", `${name}.log`);
  const lines = tail(logFile, 400);
  const errors = lines.filter(l => /error|exception|unhandled|ECONN|fatal/i.test(l) && !/level":?\s*"?(20|30)|\binfo\b/.test(l)).slice(-5);
  let rss = null;
  if (up) { const ps = sh("ps", ["-o", "rss=", "-p", String(pid)]); rss = ps ? Math.round(Number(ps) / 1024) : null; }
  return { name, up, pid: up ? pid : null, rssMb: rss, lastLines: lines.slice(-8).map(l => l.slice(0, 220)), recentErrors: errors.map(l => l.slice(0, 220)), logBytes: existsSync(logFile) ? statSync(logFile).size : 0 };
});

// ---------------------------------------------------------------- http checks
async function http(url, opts = {}) {
  const t = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000), ...opts }); const text = await r.text(); return { url, status: r.status, ms: Date.now() - t, body: text.slice(0, 200) }; }
  catch (e) { return { url, status: 0, ms: Date.now() - t, error: String(e.message || e).slice(0, 120) }; }
}
const httpChecks = {
  apiRoot: await http(API + "/"),
  apiDocs: await http(API + "/docs"),
  frontend: await http(FE + "/"),
  admin: await http(AD + "/"),
  // unauthenticated admin endpoints must be 401/403 (security regression guard)
  adminUnauth: await Promise.all(["/admin/users", "/admin/npc/status", "/admin/platform-settings", "/admin/alerts", "/admin/audit-log", "/admin/rpc", "/admin/permissions"].map(p => http(API + p))),
};

// ---------------------------------------------------------------- redis
const redis = { ok: sh("redis-cli", ["ping"]) === "PONG", keys: {}, channels: {}, samples: [] };
if (redis.ok) {
  for (const k of ["ticktrade:npc:simulator:active", "engine:leader", "ws:broadcaster:leader"]) redis.keys[k] = sh("redis-cli", ["get", k]);
  const found = (sh("redis-cli", ["--scan", "--pattern", "*leader*"]) || "").split("\n").filter(Boolean).slice(0, 10);
  for (const k of found) redis.keys[k] = sh("redis-cli", ["get", k]);
  redis.dbsize = Number(sh("redis-cli", ["dbsize"]) || 0);
  // BullMQ queue depths (keys: <prefix>:<queue>:wait|active|failed|completed|delayed)
  const qkeys = (sh("redis-cli", ["--scan", "--pattern", "*:wait"]) || "").split("\n").filter(Boolean);
  redis.queues = {};
  for (const wk of qkeys) {
    const base = wk.replace(/:wait$/, "");
    const cnt = (k, type) => Number(sh("redis-cli", [type === "list" ? "llen" : "zcard", `${base}:${k}`]) || 0);
    redis.queues[base] = { waiting: cnt("wait", "list"), active: cnt("active", "list"), delayed: cnt("delayed", "zset"), completed: cnt("completed", "zset"), failed: cnt("failed", "zset") };
  }
  // sample pub/sub traffic for N seconds
  const secs = Number(args["redis-seconds"] || 5);
  await new Promise(resolve => {
    const p = spawn("redis-cli", ["--csv", "psubscribe", "*"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    p.stdout.on("data", d => {
      buf += d.toString();
      let idx; while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        const m = line.match(/^"pmessage","\*","([^"]+)","((?:[^"\\]|\\.)*)"/);
        if (m) { const ch = m[1]; redis.channels[ch] = (redis.channels[ch] || 0) + 1; if (redis.samples.length < 12 && !redis.samples.some(s => s.channel === ch)) redis.samples.push({ channel: ch, payload: m[2].replace(/\\"/g, '"').slice(0, 300) }); }
      }
    });
    setTimeout(() => { p.kill(); resolve(); }, secs * 1000);
  });
  redis.sampleSeconds = secs;
}

// ---------------------------------------------------------------- database
const db = { ok: false, counts: {}, latestBattle: null, npc: null };
const psql = (q) => sh("psql", [DATABASE_URL, "-tAX", "-c", q]);
if (psql("select 1") === "1") {
  db.ok = true;
  const tables = ["User", "battles", "battle_participants", "ledger", "npc_traders", "npc_trades", "WithdrawalRequest", "SystemSetting", "AdminAuditLog", "risk_terminal_alerts", "price_ticks", "Candle", "IdempotencyRecord"];
  const existing = new Set((psql("select table_name from information_schema.tables where table_schema='public'") || "").split("\n"));
  for (const t of tables) if (existing.has(t)) db.counts[t] = Number(psql(`select count(*) from "${t}"`) || 0);
  db.tables = existing.size;
  db.migrations = Number(psql(`select count(*) from "_prisma_migrations" where finished_at is not null`) || 0);
  if (existing.has("battles")) {
    const cols = new Set((psql("select column_name from information_schema.columns where table_name='battles'") || "").split("\n"));
    const pick = ["id", "state", "status", "startPrice", "endPrice", "buyPot", "sellPot", "winnerSide", "startTime", "endTime", "createdAt"].filter(c => cols.has(c));
    const row = psql(`select row_to_json(t) from (select ${pick.map(c => `"${c}"`).join(",")} from battles order by "id" desc limit 1) t`);
    try { db.latestBattle = row ? JSON.parse(row) : null; } catch { db.latestBattle = row; }
    db.battlesLastHour = Number(psql(`select count(*) from battles where "createdAt" > now() - interval '1 hour'`) || 0);
  }
  if (existing.has("npc_traders")) db.npc = { total: Number(psql(`select count(*) from npc_traders`) || 0), active: Number(psql(`select count(*) from npc_traders where "isActive"`) || 0) };
  if (existing.has("battle_participants")) db.stakesLastHour = Number(psql(`select count(*) from battle_participants where "createdAt" > now() - interval '1 hour'`) || 0);
}

// ---------------------------------------------------------------- tests (parse last logs)
function parseTests(name) {
  const f = path.join(RUN, "tests", `${name}.log`);
  if (!existsSync(f)) return null;
  const txt = readFileSync(f, "utf8"); const at = statSync(f).mtime.toISOString();
  let m;
  if ((m = txt.match(/Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed, (\d+) total/))) return { name, at, failed: Number(m[1] || 0), passed: Number(m[3]), total: Number(m[4]) };
  const pass = txt.match(/^# pass (\d+)/m), fail = txt.match(/^# fail (\d+)/m), tot = txt.match(/^# tests (\d+)/m);
  if (pass || fail) return { name, at, failed: Number(fail?.[1] || 0), passed: Number(pass?.[1] || 0), total: Number(tot?.[1] || 0) };
  return { name, at, unparsed: true, tailLine: txt.trim().split("\n").slice(-1)[0]?.slice(0, 160) };
}
const tests = ["api", "engine", "shared", "admin-regression"].map(parseTests).filter(Boolean);
const failingNames = [];
for (const n of ["api", "engine", "shared"]) { const f = path.join(RUN, "tests", `${n}.log`); if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) { const m = l.match(/^not ok \d+ - (.+)$/) || l.match(/^\s+✕ (.+?)(?: \(\d+ ms\))?$/); if (m) failingNames.push(`${n}: ${m[1].slice(0, 120)}`); } }

// ---------------------------------------------------------------- browser (playwright)
const browser = { skipped: !!args["no-browser"], pages: [] };
if (!browser.skipped) {
  try {
    const require = createRequire(import.meta.url);
    const globalRoot = (() => { try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return "/home/claude/.npm-global/lib/node_modules"; } })();
    const pw = require(require.resolve("playwright", { paths: [globalRoot, "/home/claude/.npm-global/lib/node_modules", process.cwd()] }));
    const chromePath = process.env.PW_CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
    const b = await pw.chromium.launch({ headless: true, executablePath: chromePath, args: ["--no-sandbox"] });
    for (const [label, url, viewport] of [["frontend-mobile", FE + "/login", { width: 390, height: 844 }], ["frontend-desktop", FE + "/login", { width: 1280, height: 800 }], ["admin-desktop", AD + "/login", { width: 1280, height: 800 }]]) {
      const ctx = await b.newContext({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
      // no internet in the sandbox browser: serve Google Fonts as an empty stylesheet so lazy CSS chunks that @import them still load
      await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
      const page = await ctx.newPage();
      const consoleErrors = [], pageErrors = [], failedRequests = [];
      page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
      page.on("pageerror", e => pageErrors.push(String(e.message || e).slice(0, 200)));
      page.on("requestfailed", r => failedRequests.push(`${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText || ""}`));
      const t = Date.now(); let status = 0, title = "";
      try { const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 20000 }); status = resp?.status() || 0; title = await page.title(); } catch (e) { pageErrors.push("navigation: " + String(e.message).slice(0, 160)); }
      const ms = Date.now() - t;
      let shot = null;
      try { shot = "data:image/jpeg;base64," + (await page.screenshot({ type: "jpeg", quality: 55, fullPage: false })).toString("base64"); } catch { /* ignore */ }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => null);
      const textLen = await page.evaluate(() => (document.body?.innerText || "").length).catch(() => 0);
      browser.pages.push({ label, url, viewport, status, ms, title, textLen, horizontalOverflow: overflow, consoleErrors: consoleErrors.slice(0, 8), pageErrors: pageErrors.slice(0, 5), failedRequests: failedRequests.slice(0, 8), screenshot: shot });
      await ctx.close();
    }
    await b.close();
  } catch (e) { browser.error = String(e.message || e).slice(0, 300); }
}

// ---------------------------------------------------------------- browser smoke (tools/browser-smoke.cjs -> run/smoke/report.json)
let smoke = null;
try {
  const r = JSON.parse(readFileSync(path.join(RUN, "smoke", "report.json"), "utf8"));
  smoke = { at: r.at, pass: r.pass, fail: r.fail, checks: (r.checks || []).map(c => ({ name: c.name.slice(0, 120), pass: !!c.pass, detail: String(c.detail || "").slice(0, 160) })) };
} catch { smoke = null; }

// ---------------------------------------------------------------- changes log (maintained by wb changes)
let changes = [];
try { changes = JSON.parse(readFileSync(path.join(WB, "changes.json"), "utf8")); } catch { changes = []; }

// ---------------------------------------------------------------- summary + write
const upCount = services.filter(s => s.up).length;
const verdict = {
  backend: httpChecks.apiRoot.status === 200 ? "up" : "down",
  frontend: httpChecks.frontend.status === 200 ? "up" : "down",
  admin: httpChecks.admin.status === 200 ? "up" : "down",
  services: `${upCount}/${SERVICES.length}`,
  redis: redis.ok ? "up" : "down", db: db.ok ? "up" : "down",
  eventsPerSec: redis.ok ? Number((Object.values(redis.channels).reduce((a, b) => a + b, 0) / (redis.sampleSeconds || 1)).toFixed(1)) : 0,
  testsFailed: tests.reduce((a, t) => a + (t.failed || 0), 0),
  browserErrors: browser.pages.reduce((a, p) => a + p.consoleErrors.length + p.pageErrors.length, 0),
  unauthLeaks: httpChecks.adminUnauth.filter(c => c.status === 200).length,
  smokeFailed: smoke ? smoke.fail : null,
};
const snapshot = { id: `snap-${Date.now()}`, takenAt: now(), durationMs: Date.now() - t0, verdict, repos, lastBuild, services, http: httpChecks, redis, db, tests, failingTests: failingNames.slice(0, 40), browser, smoke, changes: changes.slice(-30) };
const out = args.out ? path.resolve(args.out) : path.join(WB, "snapshots", "latest.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot, null, 1));
writeFileSync(path.join(WB, "snapshots", `${snapshot.id}.json`), JSON.stringify(snapshot));
// keep only the last 20 timestamped snapshots
const olds = readdirSync(path.join(WB, "snapshots")).filter(f => f.startsWith("snap-")).sort();
for (const f of olds.slice(0, Math.max(0, olds.length - 20))) try { execFileSync("rm", ["-f", path.join(WB, "snapshots", f)]); } catch {}
console.log(JSON.stringify({ out, verdict }, null, 1));
