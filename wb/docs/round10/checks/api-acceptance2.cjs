'use strict';
const API='http://127.0.0.1:18773';
const EMAIL=process.env.DEMO_EMAIL, PASS=process.env.DEMO_PASSWORD;
const checks=[],perf=[]; let token=null; let RESET_LIB=0;
const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
async function call(m,p,b,useTok=true){const t0=Date.now();
 const r=await fetch(API+p,{method:m,headers:{'Content-Type':'application/json',...(useTok&&token?{Authorization:`Bearer ${token}`}:{})},...(b?{body:JSON.stringify(b)}:{})});
 const tx=await r.text();const ms=Date.now()-t0;perf.push({method:m,path:p,status:r.status,ms,bytes:Buffer.byteLength(tx)});
 let d;try{d=JSON.parse(tx)}catch{d=tx} return{status:r.status,data:d,ms,bytes:Buffer.byteLength(tx)};}

const SRC=`import { defineIndicator, ratio } from '@ticktrade/sdk';
export default defineIndicator({
  sdkVersion: '1', kind: 'indicator', name: 'QA Flow Bias',
  description: 'QA acceptance indicator. Descriptive only.',
  modes: ['arena'], requires: ['arena.market@1', 'arena.flow@1'],
  parameters: { windowSeconds: { type: 'integer', label: 'Window', default: 30, min: 5, max: 300 } },
  onUpdate(ctx) {
    const f = ctx.data.flow!;
    const bias = ratio(100 * (f.buy - f.sell), f.buy + f.sell);
    return { plots: [{ id: 'bias', label: 'Flow bias', placement: 'pane', value: bias, color: '#42d7ef' }],
      card: { title: 'QA FLOW', status: 'QA', metrics: [{ label: 'BIAS', value: bias, suffix: '%' }] } };
  }
});`;
const ESCAPE=`import { defineIndicator } from '@ticktrade/sdk';
export default defineIndicator({ sdkVersion:'1', kind:'indicator', name:'QA Escape', modes:['arena'], requires:['arena.market@1'],
  onUpdate(ctx){ const fs = require('fs'); const p = fs.readFileSync('/etc/passwd','utf8');
    return { plots:[{id:'x',label:'x',placement:'pane',value:p.length,color:'#fff'}] }; } });`;

(async()=>{
 const lg=await call('POST','/auth/login',{email:EMAIL,password:PASS},false);
 token=lg.data?.access_token||lg.data?.token; ok('login',!!token,`HTTP ${lg.status}`);
 if(!token)process.exit(1);

 // start from a clean slate: this harness asserts on absolute counts
 {
   const cur=await call('GET','/creator/installations');
   for (const r of (Array.isArray(cur.data)?cur.data:[])) {
     await call('PATCH',`/creator/installations/${r.id}`,{chart:false,card:false});
     await call('DELETE',`/creator/installations/${r.id}`);
   }
   const lib=await call('GET','/creator/scripts');
   for (const s of (Array.isArray(lib.data)?lib.data:[])) await call('DELETE',`/creator/scripts/${s.id}`);
   const after=await call('GET','/creator/scripts');
   const n=Array.isArray(after.data)?after.data.length:0;
   console.log(`  (reset: installations cleared, ${n} script(s) remain in the library)`);
   RESET_LIB = n;
 }
 const v=await call('POST','/creator/validate',{source:SRC});
 const vOk=(v.status===200||v.status===201)&&(v.data?.ok!==false)&&!(v.data?.errors?.length);
 ok('validate a real TickScript indicator',vOk,`HTTP ${v.status} ${v.ms}ms ${JSON.stringify(v.data).slice(0,180)}`);

 const bad=await call('POST','/creator/validate',{source:ESCAPE});
 const rej=bad.status>=400||bad.data?.ok===false||(bad.data?.errors?.length>0);
 ok('sandbox rejects filesystem access (require fs)',rej,`HTTP ${bad.status} ${JSON.stringify(bad.data).slice(0,200)}`);

 const sv=await call('POST','/creator/scripts',{source:SRC});
 const scriptId=sv.data?.id||sv.data?.script?.id, versionId=sv.data?.versionId||sv.data?.version?.id;
 ok('Apply · save privately',(sv.status===200||sv.status===201)&&!!versionId,`HTTP ${sv.status} script=${scriptId} version=${versionId}`);

 const i0=await call('GET','/creator/installations');
 const arr0=Array.isArray(i0.data)?i0.data:(i0.data?.installations||[]);
 ok('save does NOT auto-attach to the trading chart',arr0.length===0,`installations=${arr0.length}`);

 const lib=await call('GET','/creator/scripts');
 const libArr=Array.isArray(lib.data)?lib.data:(lib.data?.scripts||[]);
 ok('saved script appears in the private library',libArr.length===RESET_LIB+1,`library=${libArr.length} (was ${RESET_LIB} after reset)`);

 // explicit install (what Indicators explorer does)
 const ins=await call('POST','/creator/installations',{versionId,clientKey:'qa-client-'+Date.now(),chart:true,card:true});
 const instId=ins.data?.id||ins.data?.installation?.id;
 ok('explicit install from the explorer attaches it',(ins.status===200||ins.status===201)&&!!instId,`HTTP ${ins.status} id=${instId} ${ins.ms}ms`);

 const i1=await call('GET','/creator/installations');
 const arr1=Array.isArray(i1.data)?i1.data:(i1.data?.installations||[]);
 ok('installation now listed (no app restart needed)',arr1.length===1,`installations=${arr1.length}`);

 // live execution must be gated
 if(instId){
   const live=await call('PATCH',`/creator/installations/${instId}`,{executionMode:'live'});
   ok('live execution refused without explicit confirmation',live.status>=400,`HTTP ${live.status} ${JSON.stringify(live.data).slice(0,160)}`);
 }

 // feed (the installation data path the chart uses)
 const feed=await call('POST','/creator/installations/feed',{known:{}});
 ok('installation feed responds',feed.status===200||feed.status===201,`HTTP ${feed.status} ${feed.ms}ms ${(feed.bytes/1024).toFixed(1)}KiB`);

 // removal keeps the source
 if(instId){
   // The UI's X calls update(chart:false)/update(card:false); hiding both surfaces
   // auto-stops the run, and only a stopped run may be removed.
   await call('PATCH',`/creator/installations/${instId}`,{chart:false,card:false});
   const hidden=await call('GET','/creator/installations');
   const row=(Array.isArray(hidden.data)?hidden.data:[]).find(r=>r.id===instId);
   ok('hiding both surfaces stops the run (X on the chart/card)', row && row.enabled===false,
      `enabled=${row?.enabled} status=${row?.status}`);
   const del=await call('DELETE',`/creator/installations/${instId}`);
   ok('a stopped attachment can then be removed',del.status===200||del.status===204,`HTTP ${del.status}`);
   const lib2=await call('GET','/creator/scripts');
   const lib2Arr=Array.isArray(lib2.data)?lib2.data:(lib2.data?.scripts||[]);
   ok('removing the attachment does NOT delete the saved source',lib2Arr.length===RESET_LIB+1,`library still=${lib2Arr.length}`);
 }

 console.log('\n--- latency / payload ---');
 for(const p of perf)console.log(`  ${String(p.status).padEnd(3)} ${p.method.padEnd(6)} ${p.path.padEnd(40)} ${String(p.ms).padStart(6)}ms ${(p.bytes/1024).toFixed(1).padStart(8)} KiB`);
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
 require('fs').writeFileSync(process.env.OUT||'/tmp/a2.json',JSON.stringify({checks,perf},null,2));
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
