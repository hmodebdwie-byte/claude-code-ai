// Verifies the admin dashboard renders after login when fonts.googleapis.com is BLOCKED (requests aborted).
const path=require("node:path"),fs=require("node:fs"),{execFileSync}=require("node:child_process");
const env=Object.fromEntries(fs.readFileSync("/home/claude/wb/env/backend.env","utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).replace(/^"(.*)"$/,"$1")]}));
const {chromium}=require(path.join(execFileSync("npm",["root","-g"],{encoding:"utf8"}).trim(),"playwright"));
(async()=>{
  const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox"]});
  let rc=0;
  for (const mode of ["blocked","stubbed"]) {
    const ctx=await b.newContext({viewport:{width:1366,height:900}});
    const blocked=[];
    await ctx.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, r => { blocked.push(r.request().url().slice(0,80)); return mode==="blocked" ? r.abort("blockedbyclient") : r.fulfill({status:200,contentType:"text/css",body:""}); });
    const p=await ctx.newPage(); const errs=[];
    p.on("pageerror",e=>errs.push(String(e).slice(0,140))); p.on("console",m=>{ if(m.type()==="error") errs.push(m.text().slice(0,140)); });
    await p.goto("http://127.0.0.1:18772/login",{waitUntil:"networkidle"});
    await p.fill('input[type="email"]',env.SEED_ADMIN_EMAIL); await p.fill('input[type="password"]',env.SEED_ADMIN_PASSWORD);
    await p.click('button[type="submit"].auth-button');
    const ok=await p.locator(".admin-sidebar").first().waitFor({state:"attached",timeout:30000}).then(()=>true).catch(()=>false);
    await p.waitForTimeout(3000);
    const text=(await p.locator("body").innerText()).replace(/\s+/g," ");
    const crashed=/React Application Error/.test(text);
    const font=await p.evaluate(()=>getComputedStyle(document.querySelector(".admin-sidebar")||document.body).fontFamily).catch(()=>"?");
    await p.screenshot({path:`/home/claude/wb/run/smoke/ad-06-fonts-${mode}.png`});
    console.log(`${ok&&!crashed?"ok  ":"FAIL"} fonts ${mode}: sidebar=${ok} crashed=${crashed} fontRequests=${blocked.length} url=${new URL(p.url()).pathname} errors=${errs.filter(e=>!/fonts\.g/.test(e)).slice(0,2).join(" | ")||"none"}`);
    if(!(ok&&!crashed)) rc=1;
    await ctx.close();
  }
  await b.close(); process.exit(rc);
})().catch(e=>{console.error(e);process.exit(2)});
