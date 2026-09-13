#!/usr/bin/env node
"use strict";
/**
 * Browser smoke test for the workbench.
 *   node tools/browser-smoke.cjs            (stack must be running: wb start)
 * Logs into the trading app (mobile viewport) and the admin (desktop), exercises the patched flows
 * (trade-confirmation sheet, chat send/clear + name-above-message, admin login without the redirect
 * loop, non-admin session landing on /unauthorized) and writes screenshots + report.json to run/smoke/.
 * Depends only on node 22, psql and the globally installed playwright (npm i -g playwright).
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
// Prefer the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH) so no browser download is needed.
const CHROME = process.env.PW_CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const psql = (sql) => execFileSync("psql", [env.DATABASE_URL, "-tAc", sql], { encoding: "utf8" }).trim();
const report = { at: new Date().toISOString(), checks: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail: detail || "" });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
// The sandbox browser has no internet: Google Fonts requests would hang and, because the admin's lazy
// dashboard CSS @imports them, make Vite's CSS preload reject. Fonts are not under test, so serve an
// empty stylesheet for them (set SMOKE_REAL_FONTS=1 to disable the stub).
const stubFonts = async (ctx) => {
  if (process.env.SMOKE_REAL_FONTS) return;
  await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const section = async (name, fn) => { try { await fn(); } catch (e) { check(`${name}: section aborted`, false, String(e.message || e).split("\n")[0].slice(0, 200)); } };
  try {
    await section("frontend", async () => {
    // ------------------------------------------------------------ trading app (mobile)
    psql(`update users set "tradeConfirmation"=true where email='${env.SEED_DEMO_EMAIL}'`);
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await stubFonts(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(FE + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await shot(page, "fe-01-login.png");
    await page.fill('input[type="email"]', env.SEED_DEMO_EMAIL);
    await page.fill('input[type="password"]', env.SEED_DEMO_PASSWORD);
    await page.click('button[type="submit"].login-auth-button');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);
    await shot(page, "fe-02-arena.png");
    check("frontend: demo login lands on the arena", !new URL(page.url()).pathname.startsWith("/login"), page.url());
    check("frontend: JWT stored", !!(await page.evaluate(() => localStorage.getItem("token"))));

    // trade confirmation sheet (change c0011)
    const buy = page.locator(".btn-trade.btn-buy").first();
    if (await buy.count()) {
      // BUY/SELL are disabled during the between-round countdown ("Round starts in"); wait for the next open round.
      await buy.click({ timeout: 150000 }).catch((e) => errors.push("buy click: " + e.message.split("\n")[0]));
      await page.waitForTimeout(1200);
      const sheet = page.locator(".trade-confirm-sheet");
      const shown = (await sheet.count()) > 0 && (await sheet.first().isVisible());
      await shot(page, "fe-03-trade-confirm.png");
      check("frontend: BUY opens the confirmation sheet when the setting is on", shown,
        shown ? (await sheet.first().innerText()).replace(/\s+/g, " ").slice(0, 160) : "no .trade-confirm-sheet");
      if (shown) {
        const stakes = () => { try { return Number(psql(`select count(*) from battle_participants bp join users u on u.id = bp."userId" where u.email='${env.SEED_DEMO_EMAIL}'`)); } catch { return -1; } };
        const before = stakes();
        await page.locator(".trade-confirm-cancel").first().click({ timeout: 5000 }).catch((e) => errors.push("cancel click: " + e.message.split("\n")[0]));
        await page.waitForTimeout(800);
        const after = stakes();
        check("frontend: Cancel closes the sheet without placing an order", (await sheet.count()) === 0 && after === before, `demo stakes before=${before} after=${after}`);
      }
    } else check("frontend: BUY button present", false, "no .btn-trade.btn-buy on screen");

    // chat layout (change c0010): sender name above the text; send clears + blurs
    const chatRows = await page.locator(".chat-message").count();
    const nameAbove = await page.evaluate(() => {
      const m = document.querySelector(".chat-message"); if (!m) return null;
      const h = m.querySelector(".chat-header-info"), t = m.querySelector(".chat-text"); if (!h || !t) return null;
      return h.getBoundingClientRect().top < t.getBoundingClientRect().top;
    });
    check("frontend: chat shows the sender name above the message", nameAbove !== false,
      chatRows ? `${chatRows} messages rendered, nameAbove=${nameAbove}` : "no chat messages rendered yet");
    const input = page.locator(".chat-input").first();
    if (await input.count()) {
      await input.fill("workbench smoke " + Date.now());
      await page.locator("button.send-btn").first().click();
      await page.waitForTimeout(1000);
      const val = await input.inputValue();
      const focused = await input.evaluate((el) => document.activeElement === el);
      check("frontend: chat send clears the input and drops focus (keyboard dismissed)", val === "" && !focused, `value="${val}" focused=${focused}`);
      await shot(page, "fe-04-chat.png");
    } else check("frontend: chat input present", false, "no .chat-input");
    check("frontend: no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
    });

    await section("admin", async () => {
    // ------------------------------------------------------------ admin (desktop), admin account
    const actx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await stubFonts(actx);
    const ap = await actx.newPage();
    const aerrors = []; ap.on("pageerror", (e) => aerrors.push(String(e)));
    const navs = []; ap.on("framenavigated", (f) => { if (f === ap.mainFrame()) navs.push(new URL(f.url()).pathname); });
    await ap.goto(AD + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await ap.fill('input[type="email"]', env.SEED_ADMIN_EMAIL);
    await ap.fill('input[type="password"]', env.SEED_ADMIN_PASSWORD);
    await ap.click('button[type="submit"].auth-button');
    await ap.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 30000 }).catch(() => {});
    await ap.waitForTimeout(6000);
    await shot(ap, "ad-01-dashboard.png");
    check("admin: admin login reaches /admin and stays (no redirect loop)",
      new URL(ap.url()).pathname.startsWith("/admin") && navs.length <= 4, `${navs.length} navigations: ${navs.slice(0, 10).join(" → ")}`);
    const shell = await ap.locator(".admin-sidebar").first().waitFor({ state: "attached", timeout: 30000 }).then(() => true).catch(() => false);
    check("admin: dashboard shell renders (lazy chunk + CSS loaded)", shell, shell ? "" : (await ap.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160));
    if (shell && (await ap.locator(".admin-sidebar.collapsed").count())) await ap.locator(".sidebar-toggle").first().click().catch(() => {});
    for (const [label, file, re] of [["Risk Management Terminal", "ad-02-risk-terminal.png", /risk/i], ["NPC Simulator", "ad-03-npc-simulator.png", /simulator/i]]) {
      if (!shell) { check(`admin: "${label}" renders`, false, "dashboard shell missing"); continue; }
      // sub-items render only while their group is open (accordion): open groups one by one until the label appears
      let tab = ap.locator(".sidebar-nav").getByText(label, { exact: false }).first();
      for (const h of await ap.locator(".sidebar-group-header").all()) {
        if ((await tab.count()) && (await tab.isVisible())) break;
        await h.click().catch(() => {}); await ap.waitForTimeout(250);
        tab = ap.locator(".sidebar-nav").getByText(label, { exact: false }).first();
      }
      if (!(await tab.count())) { check(`admin: "${label}" tab present`, false, "not found in .sidebar-nav"); continue; }
      await tab.click().catch(() => {});
      await ap.waitForTimeout(6000);
      await shot(ap, file);
      const body = (await ap.locator("body").innerText()).replace(/\s+/g, " ");
      const badge = body.match(/SIMULATOR (RUNNING|ACTIVE|INACTIVE|STOPPED|OFF|ON|PAUSED)\b/i);
      check(`admin: "${label}" renders`, re.test(body), label === "NPC Simulator" ? (badge ? badge[0].trim() : "status badge not found") : body.slice(0, 120));
    }
    check("admin: no page errors", aerrors.length === 0, aerrors.slice(0, 3).join(" | "));
    await actx.close();
    });

    await section("admin non-admin", async () => {
    // ------------------------------------------------------------ admin app with a NON-admin (USER) account: change c0007
    const bctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await stubFonts(bctx);
    const bp = await bctx.newPage();
    const bnavs = []; bp.on("framenavigated", (f) => { if (f === bp.mainFrame()) bnavs.push(new URL(f.url()).pathname); });
    await bp.goto(AD + "/login", { waitUntil: "networkidle", timeout: 30000 });
    await bp.fill('input[type="email"]', env.SEED_DEMO_EMAIL);
    await bp.fill('input[type="password"]', env.SEED_DEMO_PASSWORD);
    await bp.click('button[type="submit"].auth-button');
    await bp.waitForTimeout(8000);
    await shot(bp, "ad-04-non-admin.png");
    const sawUnauthorized = bnavs.includes("/unauthorized");
    check("admin: a USER-role login lands on the 403 page instead of looping between /login and /admin",
      sawUnauthorized && new URL(bp.url()).pathname === "/unauthorized" && bnavs.length <= 8,
      `${bnavs.length} navigations: ${bnavs.slice(0, 10).join(" → ")}`);
    const signOut = bp.getByRole("button", { name: /sign in with another account/i }).first();
    if (await signOut.count()) {
      await signOut.click();
      await bp.waitForTimeout(3000);
      const tokenLeft = await bp.evaluate(() => localStorage.getItem("token"));
      check("admin: 'Sign in with another account' clears the session and returns to /login (stays there)",
        !tokenLeft && new URL(bp.url()).pathname === "/login", `path=${new URL(bp.url()).pathname} token left=${!!tokenLeft}; navigations=${bnavs.length}`);
      await shot(bp, "ad-05-after-signout.png");
    } else check("admin: sign-out button on the 403 page", false);
    await bctx.close();
    });
  } finally {
    await browser.close();
    psql(`update users set "tradeConfirmation"=false where email='${env.SEED_DEMO_EMAIL}'`);
  }
  report.pass = report.checks.filter((c) => c.pass).length;
  report.fail = report.checks.length - report.pass;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.pass}/${report.checks.length} checks passed — screenshots in ${OUT}`);
  process.exit(report.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
