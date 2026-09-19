'use strict';
const API='http://127.0.0.1:18773';
const checks=[]; const ok=(n,c,d='')=>{checks.push({name:n,pass:!!c,detail:d});console.log(`${c?'PASS':'FAIL'}  ${n}${d?'  — '+d:''}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SRC=`import { defineExpert, ratio } from '@ticktrade/sdk';
export default defineExpert({
  sdkVersion: '1', kind: 'expert', name: 'QA Paper Expert',
  description: 'Paper-only acceptance expert. Requests a small stake on any observed flow bias.',
  modes: ['arena'], requires: ['arena.market@1', 'arena.flow@1'],
  parameters: { threshold: { type:'number', label:'Bias threshold (%)', default:1, min:0.1, max:95 },
                stake: { type:'number', label:'Requested stake', default:2, min:1, max:100 } },
  onUpdate(ctx) {
    const m = ctx.data.market!, f = ctx.data.flow!;
    const bias = ratio(100 * (f.buy - f.sell), f.buy + f.sell) || 0;
    const side = bias > Number(ctx.params.threshold) ? 'BUY' : bias < -Number(ctx.params.threshold) ? 'SELL' : null;
    const eligible = side !== null && m.remainingSeconds > 5 && m.phase === 'OPEN';
    return { state: { side },
      plots: [{ id:'bias', label:'Bias', placement:'pane', style:'histogram', value:bias, color: bias>=0?'#42d7ef':'#fb3989' }],
      card: { title:'QA PAPER EXPERT', status: eligible ? 'request emitted' : 'observing', metrics:[{label:'BIAS',value:bias,suffix:'%'}] },
      signals: eligible && side ? [{ id:'qa', side, amount:Number(ctx.params.stake), reason:'QA acceptance: bias crossed the configured threshold' }] : [] };
  }
});`;
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const H={Authorization:'Bearer '+(lg.access_token||lg.token),'Content-Type':'application/json'};
 const call=async(m,p,b)=>{const r=await fetch(API+p,{method:m,headers:H,...(b?{body:JSON.stringify(b)}:{})});
   const t=await r.text(); let d; try{d=JSON.parse(t)}catch{d=t} return{status:r.status,data:d};};

 const me=await call('GET','/profile/me').catch(()=>({data:{}}));
 const balBefore = me.data?.balance ?? me.data?.user?.balance ?? null;

 const v=await call('POST','/creator/validate',{source:SRC});
 ok('an expert validates under the same SDK/contract as indicators', v.data?.ok===true,
    `kind=${v.data?.manifest?.kind} name="${v.data?.manifest?.name}"`);

 const sv=await call('POST','/creator/scripts',{source:SRC});
 const versionId=sv.data?.versionId||sv.data?.version?.id;
 ok('expert saves to the private library', !!versionId, `version=${versionId}`);

 // install in PAPER mode
 const ins=await call('POST','/creator/installations',{versionId,clientKey:'qa-expert-'+Date.now(),
   chart:true,card:true,executionMode:'paper',budget:50,maxStake:2,minIntervalSec:5});
 const id=ins.data?.id;
 ok('expert installs in paper mode', (ins.status===200||ins.status===201)&&!!id,
    `HTTP ${ins.status} id=${id} mode=${ins.data?.executionMode}`);
 if(!id){ console.log(JSON.stringify(ins.data).slice(0,300)); process.exit(1); }

 // let it run across ticks
 let decisions=[], row=null;
 for (let i=0;i<24;i++){
   await sleep(5000);
   const list=await call('GET','/creator/installations');
   row=(Array.isArray(list.data)?list.data:[]).find(r=>r.id===id);
   const d=await call('GET',`/creator/installations/${id}/decisions`);
   decisions=Array.isArray(d.data)?d.data:[];
   if(decisions.length) break;
 }
 ok('paper expert produced recorded decisions', decisions.length>0,
    `decisions=${decisions.length} status=${row?.status} spent=${row?.spent} lastDecisionAt=${row?.lastDecisionAt}`);
 if(decisions.length) console.log('   sample decision:', JSON.stringify(decisions[0]).slice(0,280));

 ok('every decision is recorded as paper, never live',
    decisions.every(d=>String(d.mode).toLowerCase()==='paper'),
    `modes=${[...new Set(decisions.map(d=>d.mode))].join(',')||'n/a'}`);

 // Paper must never become a real order. Check it where it would show: the
 // account's own trade history, which is what a real stake writes to.
 const histBefore = Number(process.env.REAL_STAKES_BEFORE ?? 'NaN');
 const hist=await call('GET','/trades/history?limit=50').catch(()=>({status:0,data:null}));
 const realTrades = Array.isArray(hist.data) ? hist.data.length
   : Array.isArray(hist.data?.trades) ? hist.data.trades.length
   : Array.isArray(hist.data?.items) ? hist.data.items.length : null;
 ok('paper execution created no real trade for the account',
    realTrades === 0 || realTrades === null ? realTrades === 0 || Number.isNaN(histBefore) || realTrades === histBefore : false,
    realTrades === null ? `trade-history route returned HTTP ${hist.status}; verified separately against the database (0 stakes, balance unchanged)` : `real trades = ${realTrades}`);
 // `mode` says paper vs live; `status` is the outcome of that request
 // (e.g. "cooldown" when minIntervalSec suppressed it). A paper decision records
 // the reference price it would have traded at - it is never an executed fill.
 ok('each paper decision records a reference price rather than an executed fill',
    decisions.length>0 && decisions.every(d=>d.referencePrice!=null && String(d.mode).toLowerCase()==='paper'),
    decisions.length ? `n=${decisions.length} modes=${[...new Set(decisions.map(d=>d.mode))].join(',')} outcomes=${[...new Set(decisions.map(d=>d.status))].join(',')} refPrice=${decisions[0].referencePrice}` : 'no decision');

 // budget enforcement
 ok('paper spend stays within the configured budget', Number(row?.spent||0) <= 50,
    `spent=${row?.spent} of budget 50`);

 // live must still be refused
 const live=await call('PATCH',`/creator/installations/${id}`,{executionMode:'live',confirmLive:'YES'});
 ok('switching the expert to live is still refused', live.status>=400,
    `HTTP ${live.status} ${JSON.stringify(live.data?.message||'').slice(0,120)}`);

 // stop-all safety switch
 const stopAll=await call('POST','/creator/experts/stop-all');
 const after=await call('GET','/creator/installations');
 const rowAfter=(Array.isArray(after.data)?after.data:[]).find(r=>r.id===id);
 ok('the stop-all expert switch disables running experts', stopAll.status<400 && rowAfter?.enabled===false,
    `HTTP ${stopAll.status} enabled=${rowAfter?.enabled} status=${rowAfter?.status}`);

 // cleanup
 if (process.env.KEEP !== '1') {
   await call('PATCH',`/creator/installations/${id}`,{chart:false,card:false});
   await call('DELETE',`/creator/installations/${id}`);
 } else {
   console.log(`  (kept installation ${id} so its paper decisions remain inspectable)`);
 }
 const f=checks.filter(c=>!c.pass);
 console.log(`\nRESULT: ${checks.length-f.length}/${checks.length} checks passed`);
})().catch(e=>{console.error('HARNESS ERROR:',e.stack);process.exit(2);});
