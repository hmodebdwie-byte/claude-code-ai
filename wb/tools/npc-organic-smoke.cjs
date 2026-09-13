#!/usr/bin/env node
"use strict";
/**
 * End-to-end check of the Organic NPC Engine (stack must be running: wb start).
 *
 *  1. Admin API: set defenses.finalInjectionLeadMs = 3000 so the lock window is visible.
 *  2. Wait for a fresh round; log the demo trader in (mobile viewport) and place one real BUY.
 *  3. Watch the live telemetry: real trade counted, projection / steering appear, lock fires
 *     ~3 s before the end and the PWA shows LOCKED buttons; NPC pots keep moving in between.
 *  4. After settlement: the audit row carries lock + final injection + invariants, the stake is settled.
 *  5. Admin UI: open NPC Simulator → Organic Engine, screenshot the three sub-tabs, put the lead
 *     time back to 150 ms through the form and save (version bump + engine applied).
 *
 * Output: run/smoke/npc-organic-report.json + screenshots run/smoke/npc-*.png
 */
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const WB = process.env.WB_ROOT || "/home/claude/wb";
const OUT = path.join(WB, "run", "smoke");
fs.mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(WB, "env/backend.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
const FE = "http://127.0.0.1:18771", AD = "http://127.0.0.1:18772", API = "http://127.0.0.1:18773";
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));
const CHROME = process.env.PW_CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const psql = (sql) => execFileSync("psql", [env.DATABASE_URL, "-tAc", sql], { encoding: "utf8" }).trim();
const report = { at: new Date().toISOString(), checks: [], notes: {} };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail: detail || "" });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const stubFonts = (ctx) => ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));

async function api(method, url, body, token) {
  const res = await fetch(API + url, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
async function login(email, password) {
  const r = await api("POST", "/auth/login", { email, password });
  return r.json?.access_token || r.json?.token || null;
}
const live = async (adminToken) => (await api("GET", "/admin/npc/organic/live", null, adminToken)).json?.live ?? null;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const finish = async () => {
    fs.writeFileSync(path.join(OUT, "npc-organic-report.json"), JSON.stringify(report, null, 2));
    const failed = report.checks.filter((c) => !c.pass).length;
    console.log(`DONE ${report.checks.length - failed}/${report.checks.length} checks passed`);
    await browser.close().catch(() => {});
    process.exit(failed ? 1 : 0);
  };
  try {
    const admin = await login(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
    check("admin API login", !!admin);
    const demo = await login(env.SEED_DEMO_EMAIL, env.SEED_DEMO_PASSWORD);
    check("demo API login", !!demo);
    if (!admin || !demo) return finish();

    // 1. make the lock window visible ----------------------------------------------------------
    const set = await api("PUT", "/admin/npc/organic/settings", { values: { defenses: { finalInjectionLeadMs: 3000 } } }, admin);
    check("admin API: PUT finalInjectionLeadMs=3000 accepted", set.status === 200 && set.json?.values?.defenses?.finalInjectionLeadMs === 3000, `http ${set.status} v${set.json?.version}`);
    const versionAfterSet = set.json?.version;
    await sleep(1500);
    const st = (await api("GET", "/admin/npc/organic/status", null, admin)).json;
    check("engine applied the pushed version within 2 s", st?.engine?.settingsVersion === versionAfterSet, `engine v${st?.engine?.settingsVersion} vs saved v${versionAfterSet}, mode ${st?.mode}, active ${st?.engine?.active}`);

    // 2. wait for a fresh round -------------------------------------------------------------
    let l = await live(admin);
    const startBattle = l?.battleId ?? null;
    const t0 = Date.now();
    while (Date.now() - t0 < 6 * 60_000) {
      l = await live(admin);
      if (l && l.battleId !== startBattle && l.elapsedSec < 30) break;
      await sleep(1000);
    }
    check("a fresh organic round started", !!l && l.battleId !== startBattle, l ? `round #${l.battleId} elapsed ${l.elapsedSec}s, lead ${l.lead?.side} ${l.lead?.sharePct}%` : "no live telemetry");
    if (!l) return finish();
    const battleId = l.battleId;
    report.notes.battleId = battleId;
    report.notes.plan = l.plan;

    // 3. demo trader: one real BUY early in the round ----------------------------------------
    psql(`update users set "tradeConfirmation"=false where email='${env.SEED_DEMO_EMAIL}'`);
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await stubFonts(ctx);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(FE + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await page.fill('input[type="email"]', env.SEED_DEMO_EMAIL);
    await page.fill('input[type="password"]', env.SEED_DEMO_PASSWORD);
    await page.click('button[type="submit"].login-auth-button');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const buy = page.locator(".btn-trade.btn-buy").first();
    check("PWA: arena renders the BUY button", (await buy.count()) > 0);
    const potsBefore = (await live(admin))?.pots;
    await buy.click({ timeout: 60000 }).catch((e) => pageErrors.push("buy click: " + e.message.split("\n")[0]));
    let realSeen = null;
    for (let i = 0; i < 20 && !realSeen; i++) { await sleep(500); const x = await live(admin); if (x && x.battleId === battleId && x.realTradeCount > 0) realSeen = x; }
    check("engine counted the real trade (recordRealTrade → boost)", !!realSeen, realSeen ? `realTradeCount ${realSeen.realTradeCount}, last ${realSeen.lastRealTrade?.side} $${realSeen.lastRealTrade?.amount}, boostActive ${realSeen.boostActive}` : "not seen within 10 s");
    await shot(page, "npc-01-after-buy.png");

    // NPC flow keeps moving and the projection appears
    let projection = null, steering = null, tradesAt = realSeen?.npcTradeCount ?? 0, moved = false, distinct = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const x = await live(admin);
      if (!x || x.battleId !== battleId) break;
      if (x.projection) projection = x.projection;
      if (x.steeringSide) steering = x.steeringSide;
      distinct = x.distinctNpcs;
      if (x.npcTradeCount > tradesAt) moved = true;
      if (projection && moved && i > 8) break;
    }
    check("NPC trades keep trickling in after the real trade (no 1:1 mirror burst)", moved, `npc trades ${tradesAt} → more, distinct NPCs ${distinct}`);
    check("projection computed once a real stake exists", !!projection, projection ? `${projection.kind} ${projection.side ?? ""} $${projection.amount} (${projection.reason}); winner ${projection.winner}` : "none");
    report.notes.projection = projection; report.notes.steering = steering; report.notes.potsBefore = potsBefore;

    // 4. the lock -------------------------------------------------------------------------------
    let lockSeen = null, uiLocked = false, uiLockDelayMs = null;
    const tl = Date.now();
    while (Date.now() - tl < 6 * 60_000) {
      const x = await live(admin);
      if (!x || x.battleId !== battleId) break;
      if (x.locked) { lockSeen = x; break; }
      await sleep(x.remainingMs > 8000 ? 1000 : 150);
    }
    if (lockSeen) {
      const tq = Date.now();
      for (let i = 0; i < 30; i++) {
        const txt = ((await buy.textContent().catch(() => "")) || "").trim();
        const disabled = await buy.isDisabled().catch(() => false);
        if (/LOCKED/i.test(txt) && disabled) { uiLocked = true; uiLockDelayMs = Date.now() - tq; break; }
        await sleep(100);
      }
      await shot(page, "npc-02-locked.png");
    }
    check("engine locked the round before the end (lead 3000 ms)", !!lockSeen, lockSeen ? `remaining ${lockSeen.remainingMs} ms, injection ${lockSeen.injection?.kind ?? "pending"}` : "lock never observed");
    check("PWA shows LOCKED + disabled buttons on battleLocked", uiLocked, uiLocked ? `within ${uiLockDelayMs} ms of the poll` : "button text/disabled state did not change");

    // locked trade is rejected server-side with ROUND_LOCKED
    const rej = await api("POST", "/trades/buy", { battle_id: battleId, amount: 10 }, demo);
    check("API rejects an order during the lock with 409 ROUND_LOCKED", rej.status === 409 && /locked/i.test(String(rej.json?.message)), `http ${rej.status}: ${rej.json?.message}`);

    // 5. settlement -----------------------------------------------------------------------------
    let audit = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const row = psql(`select coalesce(settlement::text,'') from npc_round_audit where "battleId"=${battleId}`);
      if (row) { audit = JSON.parse(row); break; }
    }
    check("directive settlement wrote the audit row", !!audit, audit ? `winner ${audit.winnerSide} (${audit.winnerReason}); commission ${audit.commission}, simProfit ${audit.simProfit}, surplus ${audit.surplusToReal}, company ${audit.companyNet}, simulator ${audit.simulatorNet}` : "no settlement in 90 s");
    if (audit) {
      const realOk = Math.abs(audit.realWinnersTotal - (audit.netRealLoserPool - audit.houseRetained + audit.surplusToReal)) < 0.02;
      check("invariant: real winners = net real loser pool + surplus", realOk, `${audit.realWinnersTotal} vs ${audit.netRealLoserPool} - ${audit.houseRetained} + ${audit.surplusToReal}`);
      check("invariant: simulator never funds real winners", audit.simulatorFundedRealWinners <= 0.01 && audit.simulatorNet >= -0.01, `simulatorFundedRealWinners ${audit.simulatorFundedRealWinners}, simulatorNet ${audit.simulatorNet}`);
      check("invariant: company net = commission (+ unpaid pool in ghost town)", Math.abs(audit.companyNet - (audit.commission + audit.houseRetained)) < 0.02, `${audit.companyNet} = ${audit.commission} + ${audit.houseRetained}`);
    }
    const fin = psql(`select coalesce("finalInjection"::text,'') , coalesce("lockedAt"::text,'') from npc_round_audit where "battleId"=${battleId}`);
    const [finJson, lockedAt] = fin.split("|");
    const finalInjection = finJson ? JSON.parse(finJson) : null;
    check("audit row holds the lock time and the final injection decision", !!lockedAt && !!finalInjection, finalInjection ? `${finalInjection.kind} planned ${finalInjection.planned} executed ${finalInjection.executed} (${finalInjection.reason}), lead ${finalInjection.lockLeadMs} ms` : "missing");
    if (finalInjection) check("lock lead follows the admin setting (~3000 ms)", finalInjection.lockLeadMs >= 2500 && finalInjection.lockLeadMs <= 3500, `${finalInjection.lockLeadMs} ms`);
    const stake = psql(`select status||'|'||payout from stakes where "battleId"=${battleId} and "userId"=(select id from users where email='${env.SEED_DEMO_EMAIL}') order by id desc limit 1`);
    check("demo stake settled (WON/LOST/REFUNDED with payout)", /^(WON|LOST|REFUNDED)\|/.test(stake), stake);
    report.notes.audit = audit; report.notes.finalInjection = finalInjection; report.notes.stake = stake;
    await page.waitForTimeout(4000);
    await shot(page, "npc-03-after-round.png");
    check("PWA: no page errors during the round", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await ctx.close();

    // 6. admin UI ------------------------------------------------------------------------------
    const actx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await stubFonts(actx);
    const ap = await actx.newPage();
    const adminErrors = [];
    ap.on("pageerror", (e) => adminErrors.push(String(e)));
    await ap.goto(AD + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await ap.fill('input[type="email"]', env.SEED_ADMIN_EMAIL);
    await ap.fill('input[type="password"]', env.SEED_ADMIN_PASSWORD);
    await ap.click('button[type="submit"].auth-button');
    await ap.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 30000 }).catch(() => {});
    await ap.waitForTimeout(2500);
    await ap.getByText("NPC Simulator", { exact: false }).first().click({ timeout: 15000 }).catch((e) => adminErrors.push("menu: " + e.message.split("\n")[0]));
    await ap.waitForTimeout(1500);
    const tab = ap.locator("button.npc-tab", { hasText: "Organic Engine" }).first();
    check("admin: Organic Engine tab present", (await tab.count()) > 0);
    await tab.click({ timeout: 10000 }).catch((e) => adminErrors.push("tab: " + e.message.split("\n")[0]));
    await ap.waitForTimeout(2500);
    const statusBar = ap.locator(".organic-status-bar").first();
    check("admin: engine status bar shows mode + engine state", (await statusBar.count()) > 0, (await statusBar.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    const fieldCount = await ap.locator(".organic-field").count();
    check("admin: schema-driven form renders every field", fieldCount >= 50, `${fieldCount} fields`);
    await shot(ap, "npc-04-admin-settings.png");
    await ap.locator("button.organic-subtab", { hasText: "Live round" }).first().click();
    await ap.waitForTimeout(2500);
    await shot(ap, "npc-05-admin-live.png");
    check("admin: live round panel renders", (await ap.locator(".organic-stats, .organic-empty").count()) > 0);
    await ap.locator("button.organic-subtab", { hasText: "Round audits" }).first().click();
    await ap.waitForTimeout(2500);
    const rowFor = ap.locator("tr.organic-row", { hasText: `#${battleId}` }).first();
    check("admin: round audits list the settled round", (await rowFor.count()) > 0, `row for #${battleId}`);
    await rowFor.click().catch(() => {});
    await ap.waitForTimeout(800);
    await shot(ap, "npc-06-admin-rounds.png");

    // restore the lead through the form (proves the form → API → engine path)
    await ap.locator("button.organic-subtab", { hasText: "Settings" }).first().click();
    await ap.waitForTimeout(1500);
    const leadInput = ap.locator("#organic-defenses-finalInjectionLeadMs");
    check("admin: lead-time field is editable", (await leadInput.count()) > 0);
    await leadInput.fill("150");
    await ap.waitForTimeout(300);
    const unsaved = await ap.locator(".organic-badge-changed").count();
    check("admin: editing marks the field unsaved", unsaved > 0, `${unsaved} badge(s)`);
    await ap.locator("button.rotation-save-btn", { hasText: "Save" }).first().click();
    await ap.waitForTimeout(2500);
    await shot(ap, "npc-07-admin-saved.png");
    const after = (await api("GET", "/admin/npc/organic/settings", null, admin)).json;
    check("admin: Save pushed the value (API shows 150, version bumped)", after?.values?.defenses?.finalInjectionLeadMs === 150 && after?.version > versionAfterSet, `v${after?.version} lead ${after?.values?.defenses?.finalInjectionLeadMs}`);
    await sleep(1500);
    const st2 = (await api("GET", "/admin/npc/organic/status", null, admin)).json;
    check("engine applied the UI-saved version", st2?.engine?.settingsVersion === after?.version, `engine v${st2?.engine?.settingsVersion}`);
    check("admin: no page errors", adminErrors.length === 0, adminErrors.slice(0, 3).join(" | "));
    await actx.close();
  } catch (e) {
    check("smoke aborted", false, String(e && e.stack || e).split("\n").slice(0, 3).join(" "));
  }
  await finish();
})();
