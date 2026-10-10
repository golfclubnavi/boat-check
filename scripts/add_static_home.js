// Embed dated, usable cards in BOTH source HTML and the formal release.
const fs=require('fs'),path=require('path');
const root=process.argv[2]||'.',file=path.join(root,'index.html');
const home=JSON.parse(fs.readFileSync(path.join(root,'data/home-live.json'),'utf8'));
if(!Array.isArray(home.venues)||home.venues.length!==24)throw Error('24 venue manifest missing');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const map=new Map(home.meetings.map(m=>[m.venueCode,m]));
const recorded=String(home.updatedAt||'').slice(11,16);
const cards=home.venues.map(({venueCode:code,venueName:name})=>{
 const m=map.get(code),title=String(m?.title||'');
 const heart=/オールレディース|ヴィーナスシリーズ|レディース|クイーン|QUEEN/.test(title)?'<span class="mark women" aria-label="女子戦">♥</span>':'';
 const first=(m?.races||[])[0]?.deadline||'';
 const minutes=first?Number(first.slice(0,2))*60+Number(first.slice(3)):0;
 const kind=minutes>=510&&minutes<=540?'morning':minutes>=680&&minutes<=780?'summer':minutes>=900&&minutes<=960?'night':minutes>=1020&&minutes<=1080?'midnight':'';
 const mark=kind?'<span class="mark '+kind+'" aria-label="'+esc(kind)+'"></span>':'';
 const head='<div class="nameRow"><span class="leftMark">'+mark+'</span><div class="venueTitle">'+esc(name)+'</div><span class="rightMark">'+heart+'</span></div>';
 if(!m)return '<div class="card off" data-code="'+code+'">'+head+'<div class="offtext"><b>保存日時点で非開催</b></div></div>';
 const grade=m.gradeVerified?m.grade:'確認中';
 const chip=grade==='一般'?'<span class="kindText">一般</span>':'<span class="gradeCenter '+esc(String(grade).toLowerCase())+'">'+esc(grade)+'</span>';
 const next=(m.races||[]).find(r=>r.deadline>recorded&&r.status!=='cancelled');
 const status=m.status==='cancelled'?'開催中止':m.status==='postponed'?'中止順延':!next?'全レース締切済':'';
 const race=status?'<div class="nextRow endedRow"><div class="endText">'+status+'</div></div>':'<div class="nextRow"><div class="nextRace"><b>'+next.raceNo+'R</b></div><div class="cutoff" aria-label="締切時刻"><b>'+esc(next.deadline)+'</b></div></div>';
 return '<div class="card '+(status?'isClosed':'isSoon')+' time-'+(kind||'other')+'" data-code="'+code+'" onclick="openVenue(\''+code+'\')">'+head+'<div class="meta">'+chip+'<span>'+esc(m.day)+'</span></div>'+race+'<div class="countdown">保存データ '+esc(recorded)+'</div><div class="progress"><i style="width:0%"></i></div></div>';
}).join('');
const snapshot={dateJST:home.dateJST,updatedAt:home.updatedAt,dailyOverview:home.dailyOverview,venues:home.venues,meetings:home.meetings.map(m=>Object.fromEntries(Object.entries(m).filter(([k])=>['venueCode','venueName','date','title','grade','gradeVerified','day','status','statusLabel'].includes(k)).concat([['races',(m.races||[]).map(r=>({raceNo:r.raceNo,deadline:r.deadline,status:r.status}))]])))};
const markup='<div class="grid" id="venues"><!-- STATIC_HOME_START -->'+cards+'<!-- STATIC_HOME_END --></div><div class="dailyOverview" id="dailyOverview" aria-label="本日の開催状況">保存データ：'+esc(home.dateJST)+' '+esc(recorded)+'・最新情報を確認中</div>';
let html=fs.readFileSync(file,'utf8');
html=html.replace(/<script type="application\/json" id="homeSnapshot">[\s\S]*?<\/script>\n?/,'');
if(html.includes('<!-- STATIC_HOME_START -->'))html=html.replace(/<div class="grid" id="venues">[\s\S]*?<!-- STATIC_HOME_END --><\/div>(?:<div class="dailyOverview"[^>]*>[^<]*<\/div>)?/,markup);
else {const needle='<div class="grid" id="venues"></div>';if(!html.includes(needle))throw Error('Home grid not found');html=html.replace(needle,markup);}
html=html.replace('<script src="racer-notebook.js"></script>','<script type="application/json" id="homeSnapshot">'+JSON.stringify(snapshot).replace(/</g,'\\u003c')+'</script>\n<script src="racer-notebook.js"></script>');
fs.writeFileSync(file,html);
console.log('[static] 24 dated cards and compact offline snapshot embedded');
