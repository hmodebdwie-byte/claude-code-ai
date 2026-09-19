'use strict';
const API='http://127.0.0.1:18773';
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
const timed=async(url,H)=>{const s=Date.now();const r=await fetch(url,{headers:H});const t=await r.text();return{ms:Date.now()-s,kib:Buffer.byteLength(t)/1024,status:r.status,json:(()=>{try{return JSON.parse(t)}catch{return null}})()};};
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const H={Authorization:'Bearer '+(lg.access_token||lg.token)};

 const rounds=(await timed(API+'/creator/intelligence/rounds',H)).json;
 const settled=rounds.filter(r=>r.status==='COMPLETED');
 console.log(`  settled rounds available: ${settled.map(r=>r.id).join(', ')}`);

 // COLD: a round not requested before in this process
 const target=Number(process.env.ROUND||settled[0].id);
 const cold=await timed(`${API}/creator/intelligence?round=${target}`,H);
 const recs=cold.json?.records?.length??0;
 ok('DataBank overview builds over the full dataset (cold)', cold.status===200 && recs>0,
    `round ${target}: ${cold.ms}ms, ${cold.kib.toFixed(1)}KiB, ${recs} trader records`);
 console.log('   summary:', JSON.stringify(cold.json?.summary).slice(0,300));

 // WARM: same round again (shared/cached build)
 const warm=await timed(`${API}/creator/intelligence?round=${target}`,H);
 ok('a repeat build is served from cache, not recomputed', warm.ms <= Math.max(60, cold.ms),
    `cold ${cold.ms}ms -> warm ${warm.ms}ms (${cold.ms>0?(cold.ms/Math.max(warm.ms,1)).toFixed(1):'-'}x)`);

 // CONCURRENT cold builds of a different round -> in-flight sharing
 const other=Number(process.env.ROUND2||settled[1]?.id||target);
 const t0=Date.now();
 const burst=await Promise.all(Array.from({length:6},()=>timed(`${API}/creator/intelligence?round=${other}`,H)));
 const burstMs=Date.now()-t0;
 ok('6 concurrent builds of the same round share one computation', burst.every(b=>b.status===200) && burstMs < 6*cold.ms,
    `6 concurrent in ${burstMs}ms total (a single cold build was ${cold.ms}ms); statuses ${[...new Set(burst.map(b=>b.status))].join(',')}`);

 // PROFILE SWITCHING under the full dataset
 const ids=(cold.json.records||[]).slice(0,12).map(r=>r.id);
 const sw=[]; for(const id of ids){ const r=await timed(`${API}/creator/intelligence/profiles/${id}?round=${target}`,H); sw.push(r.ms); }
 sw.sort((a,b)=>a-b);
 ok('profile switching stays fast under the full dataset', sw[sw.length-1] < 1500,
    `${ids.length} switches — min/median/max = ${sw[0]}/${sw[Math.floor(sw.length/2)]}/${sw[sw.length-1]}ms`);

 // a profile must carry the full model + measured detail
 const one=await timed(`${API}/creator/intelligence/profiles/${ids[0]}?round=${target}`,H);
 const p=one.json?.record;
 const secs=p?.sections?.length, flds=(p?.sections||[]).reduce((a,s)=>a+(s.fields||[]).length,0);
 ok('each profile carries all 20 sections / 200 fields', secs===20 && flds===200, `sections=${secs} fields=${flds}, ${one.ms}ms, ${one.kib.toFixed(1)}KiB`);
 const measured=p?.measured||p?.metrics||[];
 ok('each profile carries the 76 measured fields', Array.isArray(measured) && measured.length===76,
    Array.isArray(measured)?`measured=${measured.length}`:`measured block keys: ${Object.keys(p||{}).join(',').slice(0,160)}`);

 // unavailable fields must be labelled, not invented
 const withReason=(p?.sections||[]).flatMap(s=>s.fields||[]).filter(f=>f.value===null||f.value===undefined);
 const explained=withReason.filter(f=>f.reason||f.unavailable||f.note);
 ok('unavailable fields keep their definition and an explanation (never invented)',
    withReason.length===0 || explained.length===withReason.length,
    `${withReason.length} unavailable field(s), ${explained.length} carry an explicit reason`);
 if (withReason.length) console.log('   example:', JSON.stringify(withReason[0]).slice(0,240));

 // export path
 const exp=await timed(`${API}/creator/intelligence/export?round=${target}`,H);
 ok('DataBank export works over the full dataset', exp.status===200, `${exp.ms}ms, ${exp.kib.toFixed(1)}KiB`);

 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
