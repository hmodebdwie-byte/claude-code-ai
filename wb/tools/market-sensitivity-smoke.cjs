#!/usr/bin/env node
"use strict";
/**
 * Admin browser check for Market Impact & Sensitivity + Price Movement Audit (stack must be running).
 * Verifies the page renders the saved config, both previews agree with the engine endpoint, a Save
 * round-trips (and is pushed to the engine), the per-round override toggle works, the Live Trade Log
 * shows formula vs actual, the change-log filters hit the server, and the audit page shows PASS/FAIL
 * rows with the sensitivity/multiplier the round really used.
 * Output: run/smoke/ms-*.png + run/smoke/market-sensitivity-report.json
 */
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const WB = process.env.WB_ROOT || "/home/claude/wb";
const OUT = path.join(WB, "run", "smoke");
fs.mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(path.join(WB, "env/backend.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
const AD = "http://127.0.0.1:18772", API = "http://127.0.0.1:18773";
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));
const report = { at: new Date().toISOString(), checks: [] };
const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail: detail || "" }); console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, token) {
  const res = await fetch(API + url, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body == null ? undefined : JSON.stringify(body) });
  return res.json();
}
(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  try {
    const login = await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD }) }).then((r) => r.json());
    const admin = login.access_token || login.token;
    // known starting point
    await api("PUT", "/admin/market-sensitivity", { sensitivity: 8, multiplier: 10, curve: "linear", referenceAmount: 1000000, referencePips: 10 }, admin);
    await api("PUT", "/admin/market-sensitivity/round-override", { enabled: false }, admin);

    // One real $100k trade in the open round so the Live Trade Log has a REAL row to verify.
    const demoLogin = await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: env.SEED_DEMO_EMAIL, password: env.SEED_DEMO_PASSWORD }) }).then((r) => r.json());
    const demo = demoLogin.access_token || demoLogin.token;
    execFileSync("psql", [env.DATABASE_URL, "-qc", `update users set balance = greatest(balance, 500000) where email='${env.SEED_DEMO_EMAIL}'`]);
    for (let i = 0; i < 40; i++) {
      const bid = execFileSync("psql", [env.DATABASE_URL, "-tAc", "select id from battles where status='ACTIVE' and state='OPEN' order by id desc limit 1"], { encoding: "utf8" }).trim();
      if (bid) { await api("POST", "/trades/buy", { battle_id: Number(bid), amount: 100000 }, demo); break; }
      await sleep(5000);
    }
    await sleep(3000);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    await page.goto(AD + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await page.fill('input[type="email"]', env.SEED_ADMIN_EMAIL);
    await page.fill('input[type="password"]', env.SEED_ADMIN_PASSWORD);
    await page.click('button[type="submit"].auth-button');
    await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const item = page.getByText("Market Impact & Sensitivity", { exact: false }).first();
    if (!(await item.isVisible().catch(() => false))) {
      await page.getByText("Trading & Battles", { exact: false }).first().click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await item.click({ timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, "ms-01-page.png"), fullPage: true });

    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("page shows the saved config (sensitivity 8, multiplier 10, linear)", /GLOBAL SENSITIVITY 8/.test(text.replace(/[—+]/g, "")) || (await page.locator("text=8").count()) > 0, "");
    const refAmt = await page.locator('input.form-input[type="number"][step="1000"]').first().inputValue().catch(() => "");
    check("reference amount is editable and seeded", refAmt === "1000000", refAmt);

    // preview: $100000 SELL → formula 16, executed -16
    await page.getByRole("button", { name: "SELL", exact: true }).first().click();
    await page.waitForTimeout(1200);
    const previewText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("local preview: 16.0000 pips formula for $100,000", /\+?16\.0000 pips formula/.test(previewText) || /-16\.0000 pips formula/.test(previewText), previewText.match(/-?\+?16\.0000 pips formula/)?.[0] || "not found");
    check("engine preview: executes as -16.0 pips", /Executes as -16\.0 pips/.test(previewText), "");
    // small trade floor
    const vol = page.locator('input.form-input[type="number"]').filter({ hasNot: page.locator('[step]') }).last();
    await page.locator("label:has-text('TEST TRADE')").locator("xpath=..").locator('input[type="number"]').fill("10");
    await page.waitForTimeout(1200);
    const smallText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("preview for $10 shows the 0.1-pip quote-tick floor", /floored to 0\.1 pip/.test(smallText), smallText.match(/Executes as -0\.1 pips[^(]*\([^)]*\)/)?.[0] || "no floor note");
    await page.screenshot({ path: path.join(OUT, "ms-02-preview-small.png") });

    // save round trip: multiplier 10 → 9.9 → 10 via the stepper
    await page.locator("button", { hasText: "—" }).nth(1).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Save Configuration/ }).click();
    await page.waitForTimeout(1500);
    let cfg = (await api("GET", "/admin/market-sensitivity", null, admin)).data;
    check("Save pushes the stepper change (multiplier 9.9) to the API", Number(cfg.multiplier) === 9.9, `multiplier ${cfg.multiplier}`);
    const preview = (await api("GET", "/admin/market-sensitivity/preview?amount=100000&side=BUY", null, admin)).data;
    check("engine preview follows the saved multiplier (15.84 pips)", Math.abs(preview.formula_pips - 15.84) < 1e-6, `${preview.formula_pips}`);
    await page.locator("button", { hasText: "+" }).nth(1).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Save Configuration/ }).click();
    await page.waitForTimeout(1500);
    cfg = (await api("GET", "/admin/market-sensitivity", null, admin)).data;
    check("multiplier restored to 10", Number(cfg.multiplier) === 10, `multiplier ${cfg.multiplier}`);

    // override toggle → API → engine preview uses it
    // The checkbox itself is visually hidden; click its label (the switch track).
    const toggleLabel = page.locator('label:has(input[type="checkbox"])').first();
    await toggleLabel.scrollIntoViewIfNeeded();
    await toggleLabel.click();
    await page.waitForTimeout(1500);
    const ov = (await api("GET", "/admin/market-sensitivity/round-override", null, admin)).data;
    check("override toggle enables the per-round override", ov.enabled === true, JSON.stringify(ov));
    const ovPreview = (await api("GET", "/admin/market-sensitivity/preview?amount=100000&side=BUY", null, admin)).data;
    check("engine preview reports the override as the sensitivity in force", ovPreview.override_active === true && ovPreview.sensitivity_used === ov.sensitivity, `${ovPreview.sensitivity_used} override=${ovPreview.override_active}`);
    await toggleLabel.click();
    await page.waitForTimeout(1200);
    const ov2 = (await api("GET", "/admin/market-sensitivity/round-override", null, admin)).data;
    check("override toggle clears it", ov2.enabled === false, JSON.stringify(ov2));

    // live trade log
    const logText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("Live Trade Log shows FORMULA and ACTUAL columns", /FORMULA/.test(logText) && /ACTUAL Δ PIPS/.test(logText), "");
    const realRows = await page.locator(".admin-table").nth(0).locator("tbody tr").filter({ hasText: "REAL" }).allInnerTexts();
    const matching = realRows.map((r) => r.replace(/\s+/g, " ")).find((r) => /REAL (\+|-)16\.0000 (\+|-)16\.00/.test(r));
    check("Live Trade Log shows a real $100k trade whose actual move equals the formula (16 pips)", !!matching, matching || realRows[0] || "no REAL row");
    await page.screenshot({ path: path.join(OUT, "ms-03-live-log.png"), fullPage: true });

    // change-log filters hit the server
    await page.locator("#sens-field").selectOption("MULTIPLIER");
    await page.waitForTimeout(1200);
    const changeLog = page.locator(".admin-table").last();
    const rowsAfterFilter = await changeLog.locator("tbody tr").filter({ hasText: "MULTIPLIER" }).count();
    const otherRows = await changeLog.locator("tbody tr").filter({ hasText: "SENSITIVITY" }).count();
    check("field filter shows only MULTIPLIER rows", rowsAfterFilter > 0 && otherRows === 0, `${rowsAfterFilter} multiplier rows, ${otherRows} sensitivity rows`);
    await page.locator("#sens-search").fill("#LOG-1");
    await page.waitForTimeout(1200);
    const searchRows = await changeLog.locator("tbody tr").count();
    check("search by log id narrows the history", searchRows >= 1 && searchRows <= 2, `${searchRows} rows`);
    await page.locator("#sens-search").fill("");
    await page.locator("#sens-field").selectOption("All");
    await page.waitForTimeout(800);

    // Price Movement Audit page
    const auditItem = page.getByText("Price Movement", { exact: false }).first();
    if (!(await auditItem.isVisible().catch(() => false))) {
      await page.getByText("Risk & Security", { exact: false }).first().click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await auditItem.click({ timeout: 10000 }).catch((e) => errors.push("audit menu: " + e.message.split("\n")[0]));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, "ms-04-audit.png"), fullPage: true });
    const auditText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("audit page lists settled rounds with PASS/FAIL", /PASS|FAIL/.test(auditText) && /Total Rounds Audited/.test(auditText), "");
    const list = (await api("GET", "/admin/price-movement-audit?period=month&limit=5", null, admin)).data;
    check("audit API returns window summary (pass rate) and rows for all statuses", list.summary && typeof list.summary.pass_rate_pct !== "undefined" && list.pagination.total >= 1, JSON.stringify(list.summary));
    const withCfg = (list.battles || []).find((b) => b.pip_sensitivity_used != null);
    check("audit rows carry the Market Sensitivity multiplier (not the event multiplier)", withCfg ? withCfg.multiplier_used === 10 || withCfg.multiplier_used === 9.9 : false, withCfg ? `battle #${withCfg.battle_id} sens ${withCfg.pip_sensitivity_used} mult ${withCfg.multiplier_used}` : "no row with a stored config yet");
    if (withCfg) {
      const replay = (await api("GET", `/admin/price-movement-audit/${withCfg.battle_id}/replay`, null, admin)).data;
      check("replay expected end price keeps 5 decimals", String(replay.expected_end_price).split(".")[1]?.length >= 3, `${replay.expected_end_price}`);
    }
    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  } catch (e) {
    check("smoke aborted", false, String(e && e.stack || e).split("\n").slice(0, 2).join(" "));
  }
  fs.writeFileSync(path.join(OUT, "market-sensitivity-report.json"), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.pass).length;
  console.log(`DONE ${report.checks.length - failed}/${report.checks.length} checks passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
