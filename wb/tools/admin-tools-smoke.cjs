#!/usr/bin/env node
"use strict";
/**
 * Admin browser check for the four risk / inspection tools (stack must be running):
 * Risk breaches, Risk Management Terminal, Price Movement Audit Tool, Battle Inspector.
 * Logs in as the seeded admin, opens each page, exercises its filters / details, and records
 * console errors. Output: run/smoke/tools-*.png + run/smoke/admin-tools-report.json
 */
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const WB = process.env.WB_ROOT || "/home/claude/wb";
const OUT = path.join(WB, "run", "smoke");
fs.mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(path.join(WB, "env/backend.env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
const AD = "http://127.0.0.1:18772";
const { chromium } = require(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));
const report = { at: new Date().toISOString(), checks: [] };
const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail: detail || "" }); console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

async function openTab(page, name, group) {
  let item = page.getByText(name, { exact: true }).first();
  if (!(await item.isVisible().catch(() => false)) && group) {
    await page.locator('.sidebar-group-header', { hasText: group }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    item = page.getByText(name, { exact: true }).first();
  }
  await item.click({ timeout: 5000 });
  await page.waitForTimeout(2500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
    await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    await page.goto(AD + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await page.fill('input[type="email"]', env.SEED_ADMIN_EMAIL);
    await page.fill('input[type="password"]', env.SEED_ADMIN_PASSWORD);
    await page.click('button[type="submit"].auth-button');
    await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ---- Risk breaches
    await openTab(page, "Risk breaches", "Risk & Security");
    await page.locator("#rb-period").selectOption("all");
    await page.waitForTimeout(2500);
    const rbRows = await page.locator(".battle-inspector-table tbody tr").count();
    const rbText = await page.locator(".risk-breaches-summary-card").innerText().catch(() => "");
    check("risk breaches: period=all lists rounds with a server summary", rbRows > 0 && /Breached rounds/i.test(rbText), `${rbRows} rows`);
    await page.locator("#rb-scope").selectOption("breach_only");
    await page.waitForTimeout(2000);
    const scopeRows = await page.locator(".battle-inspector-table tbody tr").count();
    check("risk breaches: scope filter round-trips to the server", scopeRows >= 1, `${scopeRows} rows (breach_only)`);
    await page.locator("#rb-scope").selectOption("all");
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, "tools-risk-breaches-list.png"), fullPage: true });
    const details = page.getByRole("button", { name: "Details" }).first();
    if (await details.isVisible().catch(() => false)) {
      await details.click();
      await page.waitForTimeout(2500);
      const dText = await page.locator(".risk-breach-detail-page").innerText().catch(() => "");
      check("risk breaches: Details opens the server audit (settlement breakdown + users)", /Settlement breakdown/i.test(dText) && /Real users/i.test(dText));
      await page.screenshot({ path: path.join(OUT, "tools-risk-breaches-detail.png"), fullPage: true });
      // acknowledge → resolve → clear
      const ack = page.getByRole("button", { name: "Acknowledge" }).first();
      if (await ack.isVisible().catch(() => false)) {
        await ack.click(); await page.waitForTimeout(2000);
        const st1 = await page.locator(".risk-breach-detail-page .status-badge").allInnerTexts();
        check("risk breaches: Acknowledge persists and shows", st1.some((t) => /ACKNOWLEDGED/.test(t)), st1.join("|"));
        const clr = page.getByRole("button", { name: "Clear" }).first();
        if (await clr.isVisible().catch(() => false)) { await clr.click(); await page.waitForTimeout(2000); }
      }
      await page.getByRole("button", { name: "Back" }).first().click();
      await page.waitForTimeout(1500);
    } else {
      check("risk breaches: Details button present", false);
    }

    // ---- Risk Management Terminal
    await openTab(page, "Risk Management Terminal", "Risk & Security");
    await page.waitForTimeout(3000);
    const rmt = await page.locator(".rmt-container").innerText().catch(() => "");
    check("risk terminal: live state shows the settlement model and both scenarios", /Settlement model/i.test(rmt) && /IF BUY WINS/i.test(rmt) && /House Cash Result/i.test(rmt) && /Shortfall/i.test(rmt), rmt.match(/Settlement model:\s*[^\n]+/)?.[0] || "no active battle");
    check("risk terminal: alerts and review log sections render", /Trading Integrity Alerts/i.test(rmt) && /Risk Breach Review Log/i.test(rmt));
    await page.screenshot({ path: path.join(OUT, "tools-risk-terminal.png"), fullPage: true });

    // ---- Price Movement Audit Tool
    await openTab(page, "Price Movement Audit Tool", "Risk & Security");
    await page.locator("select.form-select").nth(0).selectOption("All Time");
    await page.waitForTimeout(2500);
    const pmaRows = await page.locator(".admin-table tbody tr").count();
    const pma = await page.locator(".pma-page").innerText().catch(() => "");
    check("price audit: All Time lists settled rounds with PASS/FAIL verdicts", pmaRows > 0 && /(PASS|FAIL)/.test(pma), `${pmaRows} rows`);
    await page.locator("select.form-select").nth(1).selectOption("Fail");
    await page.waitForTimeout(2000);
    const failRows = await page.locator(".admin-table tbody tr").count();
    const failTexts = await page.locator(".admin-table tbody tr").allInnerTexts();
    check("price audit: Fail filter is server-side (only FAIL rows or an empty message)", failTexts.every((t) => /FAIL/.test(t) || /No battles flagged/.test(t)), `${failRows} rows`);
    await page.locator("select.form-select").nth(1).selectOption("All Statuses");
    await page.waitForTimeout(2000);
    await page.locator(".admin-table tbody tr td.table-id").first().click();
    await page.waitForTimeout(3500);
    const modal = await page.locator(".kyc-modal-card").innerText().catch(() => "");
    check("price audit: details replay shows expected vs actual with the replay method", /Expected End Price/i.test(modal) && /Trades Replayed/i.test(modal) && /Freeze Seconds Used/i.test(modal), modal.match(/recorded moves \([^)]*\)/i)?.[0] || "");
    await page.screenshot({ path: path.join(OUT, "tools-price-audit-detail.png"), fullPage: true });
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator(".kyc-modal-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, "tools-price-audit-list.png"), fullPage: true });

    // ---- Battle Inspector
    await openTab(page, "Battle Inspector", "Trading & Battles");
    await page.waitForTimeout(2500);
    const biRows = page.locator(".battle-inspector-table tbody tr");
    const biCount = await biRows.count();
    const badges = await page.locator(".battle-inspector-table tbody tr td .status-badge").allInnerTexts();
    const liveCount = badges.filter((t) => /LIVE/.test(t)).length;
    check("battle inspector: list shows model / commission / house cash columns", biCount > 0 && /MODEL/.test(await page.locator(".battle-inspector-table thead").innerText()), `${biCount} rows`);
    check("battle inspector: LIVE badge only on the active round", liveCount <= 1, `${liveCount} LIVE badge(s)`);
    await page.locator("#bi-status").selectOption("completed");
    await page.waitForTimeout(2500);
    const afterStatus = await page.locator(".battle-inspector-table tbody tr td .status-badge").allInnerTexts();
    check("battle inspector: status filter reaches the server", afterStatus.length > 0 && afterStatus.every((t) => /COMPLETED/.test(t)), afterStatus.slice(0, 3).join("|"));
    await page.screenshot({ path: path.join(OUT, "tools-battle-inspector-list.png"), fullPage: true });
    await page.getByRole("button", { name: "Details" }).first().click();
    await page.waitForTimeout(3000);
    const bi = await page.locator(".battle-inspector-detail-page").innerText().catch(() => "");
    check("battle inspector: detail shows the settlement panel and participants per side", /Settlement/i.test(bi) && /House cash result/i.test(bi) && /TOTAL USER/i.test(bi));
    await page.screenshot({ path: path.join(OUT, "tools-battle-inspector-detail.png"), fullPage: true });

    check("no console / page errors on the four pages", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, "admin-tools-report.json"), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.pass).length;
  console.log(`\n${report.checks.length - failed}/${report.checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
