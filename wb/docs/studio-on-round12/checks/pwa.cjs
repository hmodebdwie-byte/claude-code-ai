'use strict';
const { chromium } = require('playwright');
const fs=require('fs'), path=require('path');
const API='http://127.0.0.1:18773', APP=process.env.APP||'http://127.0.0.1:18771';
const DIST=process.env.DIST;
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const token=lg.access_token||lg.token;
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox']});
 const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,serviceWorkers:'allow'});
 const page=await ctx.newPage();
 await page.addInitScript(([t])=>{localStorage.setItem('token',t);localStorage.setItem('role','user');},[token]);
 await page.goto(APP+'/',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(12000);

 // 1. manifest
 const man=await page.evaluate(async()=>{
   const l=document.querySelector('link[rel="manifest"]'); if(!l) return null;
   try{ const r=await fetch(l.href); const j=await r.json();
     return {href:l.href,name:j.name,short:j.short_name,display:j.display,icons:(j.icons||[]).length,start:j.start_url}; }catch(e){return {href:l.href,error:String(e)}}
 });
 ok('web app manifest is served and installable-shaped',
    !!man && man.icons>=2 && /standalone|fullscreen|minimal-ui/.test(man.display||''),
    man?`name="${man.name}" display=${man.display} icons=${man.icons} start=${man.start}`:'no manifest link');

 // 2. service worker registers and takes control
 const reg=await page.evaluate(async()=>{
   if(!('serviceWorker' in navigator)) return {supported:false};
   const r=await navigator.serviceWorker.getRegistration();
   if(!r) return {supported:true,registered:false};
   await navigator.serviceWorker.ready;
   return {supported:true,registered:true,scope:r.scope,
     active:!!r.active,state:r.active?.state,script:r.active?.scriptURL,
     controlled:!!navigator.serviceWorker.controller};
 });
 ok('service worker registers, activates and controls the page',
    reg.registered && reg.active && reg.controlled, JSON.stringify(reg));

 // 3. precache actually populated
 const cache=await page.evaluate(async()=>{
   const names=await caches.keys(); const out={};
   for(const n of names){ const c=await caches.open(n); out[n]=(await c.keys()).length; }
   return out;
 });
 const total=Object.values(cache).reduce((a,b)=>a+b,0);
 ok('the navigation shell is actually precached', total>0, `caches=${JSON.stringify(cache)} total entries=${total}`);

 // 4. OFFLINE: the shell must still boot
 await ctx.setOffline(true);
 const offline=await page.goto(APP+'/',{waitUntil:'domcontentloaded',timeout:45000}).then(r=>r?.status()??0).catch(e=>'ERR:'+e.message);
 await page.waitForTimeout(4000);
 const offlineBody=(await page.locator('body').innerText().catch(()=>'')).replace(/\n+/g,' | ').slice(0,140);
 const offlineHasApp=await page.locator('#root, .app-root-column, [class*="layout"]').count();
 ok('the app shell loads with the network offline', offlineHasApp>0,
    `nav status=${offline}, root nodes=${offlineHasApp}, body="${offlineBody}"`);
 await ctx.setOffline(false);

 // 5. UPDATE: publish a new build, then check the SW sees a waiting worker
 let updateSeen=null;
 if (DIST) {
   const swPath=path.join(DIST,'sw.js');
   const before=fs.readFileSync(swPath,'utf8');
   fs.writeFileSync(swPath, before + `\n// qa-update-marker ${Date.now()}\n`);
   try {
     updateSeen=await page.evaluate(async()=>{
       const r=await navigator.serviceWorker.getRegistration();
       if(!r) return {registered:false};
       await r.update();
       // give the browser a moment to fetch and install the new script
       await new Promise(res=>setTimeout(res,3000));
       return {installing:!!r.installing, waiting:!!r.waiting, active:!!r.active};
     });
   } finally { fs.writeFileSync(swPath, before); }
   ok('a new build is detected by the running service worker',
      !!updateSeen && (updateSeen.waiting || updateSeen.installing),
      JSON.stringify(updateSeen));
 } else {
   ok('a new build is detected by the running service worker', false, 'DIST not provided — skipped');
 }

 // 6. account storage survives an update check
 const tokenStill=await page.evaluate(()=>localStorage.getItem('token'));
 ok('account storage survives the update check', !!tokenStill, tokenStill?'token still present':'token lost');

 await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/pwa.png'});
 await b.close();
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
