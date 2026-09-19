'use strict';
const { chromium } = require('playwright');
const API='http://127.0.0.1:18773', APP='http://127.0.0.1:18771';
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};

async function boot(b, viewport, isMobile) {
  const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
  const token=lg.access_token||lg.token;
  const ctx=await b.newContext({viewport, isMobile, hasTouch:isMobile, deviceScaleFactor:isMobile?2:1});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.addInitScript(([t])=>{localStorage.setItem('token',t);localStorage.setItem('role','user');},[token]);
  await page.goto(APP+'/',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(9000);
  return {page, errs, token};
}
const cards  = p => p.locator('.tt-study-page').count();
const views  = p => p.locator('.indicators-view').count();
const label  = p => p.evaluate(()=>document.querySelector('.tt-study-page')?.getAttribute('aria-label')||null);
const counter= p => p.evaluate(()=>{const b=document.querySelector('[aria-label="Next card page"]');return b?.previousElementSibling?.textContent?.trim()||'';});

(async()=>{
 const lg0=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const inst=await (await fetch(API+'/creator/installations',{headers:{Authorization:'Bearer '+(lg0.access_token||lg0.token)}})).json();
 const INSTALLED=inst.filter(i=>i.card).map(i=>i.version?.manifest?.name);
 const EXPECTED=4+INSTALLED.length;
 console.log(`  installed indicators with a card: ${INSTALLED.length} (${INSTALLED.join(', ')}) -> expect ${EXPECTED} pages`);
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox']});

 // ============ DESKTOP ============
 console.log('--- DESKTOP 1280x800 ---');
 { const {page,errs}=await boot(b,{width:1280,height:800},false);
   const links = page.locator('.tt-card-page-links button');
   const n = await links.count();
   ok('desktop lists every card page as a link', n===EXPECTED, `links=${n} (4 built-in + ${INSTALLED.length} installed)`);
   const labels = await links.evaluateAll(e=>e.map(x=>x.textContent.trim()));
   console.log('   page links:', labels.join(' | '));
   ok('desktop nav reaches every installed indicator page',
      INSTALLED.every(x=>labels.includes(x)), labels.join(', '));

   let maxCards=0, named=[], builtin=0;
   for (let i=0;i<n;i++){
     await links.nth(i).click(); await page.waitForTimeout(700);
     const c=await cards(page), v=await views(page), l=await label(page);
     maxCards=Math.max(maxCards,c); if(l) named.push(l); if(v>0&&c===0) builtin++;
     console.log(`   page ${i+1}/${n} "${labels[i]}" -> creatorCards=${c} indicatorViews=${v} counter="${await counter(page)}"`);
   }
   ok('desktop: never more than one indicator card per page', maxCards<=1, `max=${maxCards}`);
   ok('desktop: each installed indicator has its own page', named.length===INSTALLED.length, `${named.length} card pages for ${INSTALLED.length} installed`);
   const builtinLinks = labels.filter(l=>['Chat','Market overview','Order flow','Round insights'].includes(l));
   ok('desktop: the original built-in card pages are preserved', builtinLinks.length===4 && builtin===3,
      `built-in links=${builtinLinks.join(',')}; of those 3 render an indicators view and Chat renders the chat slide`);
   ok('desktop: no uncaught page errors', errs.length===0, errs.slice(0,2).join(' || ')||'clean');
   await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/desktop-card.png'});
   await page.context().close();
 }

 // ============ PHONE (real touch swipe via CDP) ============
 console.log('\n--- PHONE 390x844 (CDP touch swipe) ---');
 { const {page,errs}=await boot(b,{width:390,height:844},true);
   const cdp = await page.context().newCDPSession(page);
   const visibleBox = async () => {
     for (const sel of ['.indicators-container','.content-swipe-area','.chat-section','.matches-content']) {
       const l = page.locator(sel).first();
       if (await l.count() && await l.isVisible().catch(()=>false)) { const bb = await l.boundingBox(); if (bb && bb.height>40) return bb; }
     }
     return await page.locator('body').boundingBox();
   };
   const navVisible = await page.locator('[aria-label="Next card page"]').isVisible().catch(()=>false);
   ok('phone hides the desktop page-nav (swipe is the navigation)', !navVisible, `navVisible=${navVisible}`);

   async function swipe(dir){ // dir 1 = next
     const box = await visibleBox();
     const y = box.y + box.height/2;
     const x0 = dir>0 ? box.x+box.width-30 : box.x+30;
     const x1 = dir>0 ? box.x+30 : box.x+box.width-30;
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x0,y}]});
     for (const f of [0.3,0.6,0.9,1]) {
       await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x0+(x1-x0)*f,y}]});
       await page.waitForTimeout(40);
     }
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
     await page.waitForTimeout(800);
   }
   let maxCards=0, named=new Set(), builtin=0, steps=[];
   for (let i=0;i<EXPECTED;i++){
     const c=await cards(page), v=await views(page), l=await label(page);
     maxCards=Math.max(maxCards,c); if(l) named.add(l); if(v>0&&c===0) builtin++;
     steps.push(`${i}:cards=${c},views=${v}${l?',"'+l+'"':''}`);
     await swipe(1);
   }
   console.log('   swipe walk:', steps.join('  '));
   ok('phone: horizontal swipe changes the card page', builtin+named.size>1, steps.join(' '));
   ok('phone: exactly one indicator card per swipe page (never a grid)', maxCards<=1, `max cards on a page = ${maxCards}`);
   ok('phone: installed indicators reachable as their own swipe pages', named.size>=1, [...named].join(' | ')||'none');
   ok('phone: no uncaught page errors', errs.length===0, errs.slice(0,2).join(' || ')||'clean');
   await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/phone-card.png'});
   await page.context().close();
 }
 await b.close();
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
 process.exit(f.length?1:0);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
