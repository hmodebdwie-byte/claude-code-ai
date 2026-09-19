'use strict';
const API='http://127.0.0.1:18773';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const H={Authorization:'Bearer '+(lg.access_token||lg.token)};
 const snap=async()=>{ const r=await (await fetch(API+'/creator/installations',{headers:H})).json();
   return r.map(x=>({n:x.version?.manifest?.name,s:x.status,e:x.error,t:x.output?.time,round:x.roundId,warm:x.warmupStatus,en:x.enabled})); };
 console.log('watching up to 7 minutes for a round transition...\n');
 let prev=await snap(); let seenRounds=new Set(prev.map(p=>p.round));
 let sawStale=prev.every(p=>p.s==='stale'), sawRunning=false, recovered=false, transitions=0;
 const t0=Date.now();
 let lastLine='';
 while (Date.now()-t0 < 7*60*1000) {
   await sleep(5000);
   const cur=await snap();
   const statuses=[...new Set(cur.map(c=>c.s))].join(',');
   const rounds=[...new Set(cur.map(c=>c.round))].join(',');
   const fresh=cur.filter(c=>c.t&&Date.now()-c.t<15000).length;
   const line=`t+${((Date.now()-t0)/1000).toFixed(0).padStart(3)}s status=[${statuses}] round=[${rounds}] fresh(<15s)=${fresh}/8 enabled=${cur.filter(c=>c.en).length}/8`;
   if(line.slice(0,60)!==lastLine.slice(0,60)||((Date.now()-t0)%30000<5000)){ console.log('  '+line); lastLine=line; }
   for(const c of cur) if(c.round!=null) seenRounds.add(c.round);
   if(cur.every(c=>c.s==='stale')) sawStale=true;
   if(cur.some(c=>c.s==='running'||c.s==='ready')) { sawRunning=true; if(sawStale) recovered=true; }
   if(cur.some(c=>c.round!=null && !prev.some(p=>p.round===c.round))) transitions++;
   prev=cur;
   if(recovered && transitions>0) { console.log('\n  >>> observed a stale -> running recovery across a round change'); break; }
 }
 const final=await snap();
 console.log('\nFINAL:');
 for(const f of final) console.log(`  ${String(f.n).padEnd(4)} status=${String(f.s).padEnd(9)} round=${f.round} enabled=${f.en} warmup=${f.warm} age=${f.t?((Date.now()-f.t)/1000).toFixed(1)+'s':'n/a'} err=${JSON.stringify(f.e)}`);
 console.log('\nrounds observed:', [...seenRounds].join(', '));
 console.log(`sawStale=${sawStale} sawRunning=${sawRunning} recovered=${recovered} roundChanges=${transitions}`);
 console.log(`ALL 8 STILL INSTALLED AND ENABLED: ${final.length===8 && final.every(f=>f.en)}`);
 console.log(recovered ? 'PASS  indicators recover after a round transition'
                       : (sawRunning ? 'PASS  indicators are running (no stale period needing recovery in this window)'
                                     : 'FAIL  indicators never resumed in the observed window'));
})().catch(e=>{console.error(e.stack);process.exit(1);});
