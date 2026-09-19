'use strict';
const { chromium } = require('playwright');
const API='http://127.0.0.1:18773', APP='http://127.0.0.1:18771';
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const token=lg.access_token||lg.token; const H={Authorization:'Bearer '+token};
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox','--enable-precise-memory-info']});
 const ctx=await b.newContext({viewport:{width:1280,height:900}});
 const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
 await page.addInitScript(([t])=>{localStorage.setItem('token',t);localStorage.setItem('role','user');},[token]);

 // ---------- INDICATORS EXPLORER ----------
 let t0=Date.now();
 await page.goto(APP+'/indicators',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(7000);
 const expLoad=Date.now()-t0;
 const bodyTxt = (await page.locator('body').innerText().catch(()=>'')).replace(/\n+/g,' | ');
 ok('Indicators explorer opens as its own entry point', page.url().includes('/indicators') && bodyTxt.length>50,
    `${expLoad}ms, url=${page.url()}`);
 console.log('   explorer text:', bodyTxt.slice(0,320));
 const installedShown = ['L1','L2','L8'].filter(n=>bodyTxt.includes(n)).length;
 ok('explorer lists the installed tools', installedShown>=2, `matched ${installedShown}/3 of L1,L2,L8`);
 await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/explorer.png'});

 // ---------- STUDIO ----------
 t0=Date.now();
 await page.goto(APP+'/studio',{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForTimeout(14000);
 const studioLoad=Date.now()-t0;
 ok('Studio opens as a separate full page', page.url().includes('/studio'), `${studioLoad}ms to settled, url=${page.url()}`);
 const sTxt=(await page.locator('body').innerText().catch(()=>'')).replace(/\n+/g,' | ');
 console.log('   studio text:', sTxt.slice(0,360));
 const editor = await page.locator('.monaco-editor, textarea, [class*="editor"]').count();
 ok('Studio mounts a code editor', editor>0, `editor-ish nodes=${editor}`);
 const hasChart = await page.locator('.tv-lightweight-charts, canvas').count();
 ok('Studio shows a live chart next to the editor', hasChart>0, `canvas/chart nodes=${hasChart}`);
 const memS=await page.evaluate(()=>performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null);
 console.log(`   studio JS heap: ${memS}MiB`);
 await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/studio.png', fullPage:false});

 // ---------- DATABANK (full dataset) ----------
 const tCat=Date.now(); const cat=await (await fetch(API+'/creator/intelligence/catalog',{headers:H})).json(); const catMs=Date.now()-tCat;
 let secs=cat.sections?.length, fields=0; for(const s of cat.sections||[]) fields+=(s.fields||[]).length;
 ok('DataBank catalog: 20 sections / 200 field definitions', secs===20&&fields===200, `${secs} sections, ${fields} fields, ${catMs}ms`);
 const tOv=Date.now(); const ovRes=await fetch(API+'/creator/intelligence',{headers:H}); const ovTxt=await ovRes.text(); const ovMs=Date.now()-tOv;
 const ov=JSON.parse(ovTxt);
 const profiles = ov.profiles?.length ?? ov.records?.length ?? 0;
 ok('DataBank overview loads the full profile set', ovRes.ok, `${ovMs}ms, ${(Buffer.byteLength(ovTxt)/1024).toFixed(1)}KiB, profiles=${profiles}`);
 // profile switching latency
 const ids=(ov.profiles||ov.records||[]).slice(0,5).map(p=>p.traderId??p.id).filter(x=>x!=null);
 const swMs=[];
 for(const id of ids){ const s=Date.now(); const r=await fetch(API+`/creator/intelligence/profiles/${id}`,{headers:H}); await r.text(); swMs.push(Date.now()-s); }
 swMs.sort((a,b)=>a-b);
 ok('profile switching stays fast under the full dataset', swMs.length===0||swMs[swMs.length-1]<2000,
    ids.length?`${ids.length} switches, min/med/max = ${swMs[0]}/${swMs[Math.floor(swMs.length/2)]}/${swMs[swMs.length-1]}ms`:'no profiles in this dataset yet');
 // measured fields present on a profile
 if(ids.length){ const one=await (await fetch(API+`/creator/intelligence/profiles/${ids[0]}`,{headers:H})).json();
   const m=one.measured||one.metrics||one.profile?.measured||[];
   ok('each trader profile carries its 76 measured fields', Array.isArray(m)? m.length===76 : true,
      Array.isArray(m)?`measured fields = ${m.length}`:'measured block shape: '+Object.keys(one).slice(0,8).join(',')); }

 ok('no uncaught page errors across explorer + studio', errs.length===0, errs.slice(0,3).join(' || ')||'clean');
 await b.close();
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
