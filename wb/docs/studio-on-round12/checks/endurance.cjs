'use strict';
const fs=require('fs'); const API='http://127.0.0.1:18773';
const MIN=Number(process.env.MINUTES||60), OUT=process.env.OUT||'/tmp/endurance.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rss=pid=>{try{const s=fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/VmRSS:\s+(\d+)/);return s?Math.round(+s[1]/1024):null}catch{return null}};
(async()=>{
 const lg=await (await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:process.env.DEMO_EMAIL,password:process.env.DEMO_PASSWORD})})).json();
 const H={Authorization:'Bearer '+(lg.access_token||lg.token),'Content-Type':'application/json'};
 // Re-resolve each sample: a restart changes the pid, and pinning it once made
 // every later RSS reading null.
 const apiPidNow=()=>{try{return Number(require('child_process').execSync("ps -eo pid,cmd | grep 'dist/main.js' | grep -v grep | awk '{print $1}' | head -1").toString().trim())||null}catch{return null}};
 let apiPid=apiPidNow();
 const samples=[], rounds=new Set(); let feedFail=0, feedOk=0, transitions=0, prevRound=null, minEnabled=99;
 const t0=Date.now();
 console.log(`endurance: ${MIN} min, api pid ${apiPid}`);
 while (Date.now()-t0 < MIN*60*1000) {
   const tick=Date.now();
   let rows=[], feedMs=null;
   try {
     const s=Date.now();
     const f=await fetch(API+'/creator/installations/feed',{method:'POST',headers:H,body:JSON.stringify({known:{}})});
     feedMs=Date.now()-s; f.ok?feedOk++:feedFail++;
     rows=await (await fetch(API+'/creator/installations',{headers:H})).json();
   } catch(e){ feedFail++; }
   const enabled=rows.filter(r=>r.enabled).length;
   minEnabled=Math.min(minEnabled, rows.length?enabled:minEnabled);
   const round=rows[0]?.roundId;
   if(round!=null){ rounds.add(round); if(prevRound!=null&&round!==prevRound) transitions++; prevRound=round; }
   const fresh=rows.filter(r=>r.output?.time && Date.now()-r.output.time<20000).length;
   apiPid=apiPidNow();
   samples.push({t:Math.round((Date.now()-t0)/1000), rss:apiPid?rss(apiPid):null, installs:rows.length, enabled, fresh, round, feedMs,
                 statuses:[...new Set(rows.map(r=>r.status))].join('|')});
   const s=samples[samples.length-1];
   if(samples.length%10===1) console.log(`  t+${String(s.t).padStart(4)}s rss=${s.rss}MiB installs=${s.installs} enabled=${s.enabled} fresh=${s.fresh} round=${s.round} feed=${s.feedMs}ms [${s.statuses}]`);
   await sleep(Math.max(0, 15000-(Date.now()-tick)));
 }
 const rssV=samples.map(s=>s.rss).filter(Boolean);
 const feeds=samples.map(s=>s.feedMs).filter(Boolean).sort((a,b)=>a-b);
 const summary={
   minutes:MIN, samples:samples.length,
   rssStartMiB:rssV[0], rssEndMiB:rssV[rssV.length-1], rssMaxMiB:Math.max(...rssV), rssGrowthMiB:rssV[rssV.length-1]-rssV[0],
   feedOk, feedFail, feedMs:{min:feeds[0],median:feeds[Math.floor(feeds.length/2)],p95:feeds[Math.floor(feeds.length*0.95)],max:feeds[feeds.length-1]},
   roundsObserved:[...rounds], roundTransitions:transitions,
   installsStart:samples[0]?.installs, installsEnd:samples[samples.length-1]?.installs,
   minEnabledSeen:minEnabled,
 };
 fs.writeFileSync(OUT, JSON.stringify({summary,samples},null,1));
 console.log('\n=== ENDURANCE SUMMARY ==='); console.log(JSON.stringify(summary,null,1));
})().catch(e=>{console.error('ENDURANCE ERROR:',e.stack);process.exit(1);});
