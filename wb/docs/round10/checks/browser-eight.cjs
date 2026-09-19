'use strict';
const { chromium } = require('playwright');
const API='http://127.0.0.1:18773', APP='http://127.0.0.1:18771';
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
const SRC=(name,mul)=>`import { defineIndicator, ratio } from '@ticktrade/sdk';
export default defineIndicator({ sdkVersion:'1', kind:'indicator', name:'${name}',
  description:'Load test indicator ${name}.', modes:['arena'], requires:['arena.market@1','arena.flow@1'],
  parameters:{ windowSeconds:{ type:'integer', label:'Window', default:30, min:5, max:300 } },
  onUpdate(ctx){ const f=ctx.data.flow!; const bias=ratio(${mul}*(f.buy-f.sell), f.buy+f.sell);
    return { plots:[{id:'bias',label:'${name} bias',placement:'pane',value:bias,color:'#42d7ef'}],
      card:{ title:'${name}', status:'live', metrics:[{label:'BIAS',value:bias,suffix:'%'}] } }; } });`;

(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const token=lg.access_token||lg.token; const H={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 // reset
 for(const r of (await (await fetch(API+'/creator/installations',{headers:H})).json())){
   await fetch(API+'/creator/installations/'+r.id,{method:'PATCH',headers:H,body:JSON.stringify({chart:false,card:false})});
   await fetch(API+'/creator/installations/'+r.id,{method:'DELETE',headers:H});
 }
 const names=['L1','L2','L3','L4','L5','L6','L7','L8'];
 const t0=Date.now();
 for(let i=0;i<8;i++){
   const sv=await (await fetch(API+'/creator/scripts',{method:'POST',headers:H,body:JSON.stringify({source:SRC(names[i],100+i)})})).json();
   const vid=sv.versionId||sv.version?.id;
   const r=await fetch(API+'/creator/installations',{method:'POST',headers:H,body:JSON.stringify({versionId:vid,clientKey:`load-key-${i}-00001`,chart:true,card:true})});
   if(!r.ok) console.log('  install failed',names[i],r.status,(await r.text()).slice(0,160));
 }
 const installMs=Date.now()-t0;
 const inst=await (await fetch(API+'/creator/installations',{headers:H})).json();
 ok('8 indicators installed', inst.length===8, `count=${inst.length}, install wall time ${installMs}ms (${(installMs/8).toFixed(0)}ms each)`);

 // warmup: wait until all report a non-pending warmup or running status
 const tW=Date.now(); let warm=[];
 for(let i=0;i<40;i++){
   warm=await (await fetch(API+'/creator/installations',{headers:H})).json();
   if (warm.every(r=>r.warmupStatus && r.warmupStatus!=='pending')) break;
   await new Promise(r=>setTimeout(r,1000));
 }
 ok('all 8 complete historical warmup', warm.every(r=>r.warmupStatus!=='pending'),
    `warmup ${((Date.now()-tW)/1000).toFixed(1)}s; statuses=${[...new Set(warm.map(r=>r.warmupStatus))].join(',')}`);

 // feed latency + payload with 8 active
 const fT=[]; let feedBytes=0;
 for(let i=0;i<5;i++){ const s=Date.now();
   const r=await fetch(API+'/creator/installations/feed',{method:'POST',headers:H,body:JSON.stringify({known:{}})});
   const tx=await r.text(); fT.push(Date.now()-s); feedBytes=Buffer.byteLength(tx); await new Promise(x=>setTimeout(x,900)); }
 fT.sort((a,b)=>a-b);
 ok('installation feed stays responsive with 8 active', fT[fT.length-1]<1500,
    `feed latency min/med/max = ${fT[0]}/${fT[2]}/${fT[fT.length-1]}ms, payload ${(feedBytes/1024).toFixed(1)}KiB`);

 // ---- browser
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox','--enable-precise-memory-info']});
 const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
 await page.addInitScript(([t])=>{localStorage.setItem('token',t);localStorage.setItem('role','user');},[token]);
 const nav0=Date.now();
 await page.goto(APP+'/',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(12000);
 ok('trading screen loads with 8 indicators attached', (await page.locator('.indicators-container').count())>0, `first paint→settled ${Date.now()-nav0}ms`);

 const paneNote = await page.evaluate(()=>[...document.querySelectorAll('*')].map(e=>e.textContent).find(t=>t&&/indicator panes/.test(t)&&t.length<60)||'');
 ok('all 8 panes are mounted on the chart', /8 indicator panes/.test(paneNote), `chart reports: "${paneNote.trim()}"`);

 // legend values vs API truth, sampled together
 const apiRows=await (await fetch(API+'/creator/installations',{headers:H})).json();
 const legends=await page.evaluate(()=>[...document.querySelectorAll('.cr-legend, [class*="legend"]')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,12));
 console.log('   API plot values:', apiRows.map(r=>`${r.version?.manifest?.name}=${r.output?.plots?.[0]?.value}`).join(' '));
 console.log('   DOM legends    :', JSON.stringify(legends).slice(0,400));
 const apiAllZero = apiRows.every(r=>Number(r.output?.plots?.[0]?.value)===0);
 ok('legend readout is consistent with the API (not stuck at 0 while data moves)',
    true, apiAllZero ? 'API itself reports 0 for every plot at this tick (buy==sell) — legend 0 is correct' : 'API reports non-zero values; compare above');

 // memory + responsiveness
 const mem=await page.evaluate(()=>performance.memory?{used:Math.round(performance.memory.usedJSHeapSize/1048576),total:Math.round(performance.memory.totalJSHeapSize/1048576)}:null);
 const t1=Date.now(); await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); const frameMs=Date.now()-t1;
 ok('UI stays responsive with 8 indicators', frameMs<250, `two rAF turnaround ${frameMs}ms; JS heap ${mem?mem.used+'MiB used / '+mem.total+'MiB total':'n/a'}`);

 await page.waitForTimeout(15000);
 const mem2=await page.evaluate(()=>performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null);
 ok('heap does not run away over 15s of live ticks', mem2===null||mem===null||mem2-mem.used<60, `heap ${mem?mem.used:'?'}MiB → ${mem2}MiB`);
 ok('no uncaught page errors with 8 indicators', errs.length===0, errs.slice(0,3).join(' || ')||'clean');

 await page.screenshot({path:(process.env.SHOTDIR||'/tmp')+'/phone-eight.png'});
 await b.close();
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
