
const DATA_URL="data/home-live.json";
const RECENT20_URL="./data/recent20.json";
const VENUES=[
["01","桐生"],["02","戸田"],["03","江戸川"],["04","平和島"],["05","多摩川"],["06","浜名湖"],
["07","蒲郡"],["08","常滑"],["09","津"],["10","三国"],["11","びわこ"],["12","住之江"],
["13","尼崎"],["14","鳴門"],["15","丸亀"],["16","児島"],["17","宮島"],["18","徳山"],
["19","下関"],["20","若松"],["21","芦屋"],["22","福岡"],["23","唐津"],["24","大村"]
];
const $=id=>document.getElementById(id);
let state={meetings:[],recentResults:[],recent20ByRacer:{},updatedAt:null,dateJST:null,currentMeeting:null,currentMeetingView:null,currentRace:null,currentDayDate:null};
let homeLoadPromise=null;
let homeRetryTimer=null;
let refreshingLive=false;
let settlementLoadAt=0;
const loadedVenues=new Set();
const optionalLoads={};
function adoptHomeMeetings(d){
  const previous=new Map(state.meetings.map(m=>[m.venueCode,m]));
  if(d.dateJST!==state.dateJST)loadedVenues.clear();
  return d.meetings.map(m=>{
    const full=loadedVenues.has(m.venueCode)?previous.get(m.venueCode):null;
    if(!full||full.date!==m.date)return m;
    Object.assign(full,Object.fromEntries(Object.entries(m).filter(([k])=>k!=="races"&&k!=="meetDays")));
    const fresh=new Map((m.races||[]).map(r=>[Number(r.raceNo),r]));
    (full.races||[]).forEach(r=>{const small=fresh.get(Number(r.raceNo));if(small)for(const k of ["deadline","status","statusLabel","note"])if(k in small)r[k]=small[k];});
    return full;
  });
}
function loadOnce(key,fn){return optionalLoads[key]||(optionalLoads[key]=fn().catch(error=>{delete optionalLoads[key];throw error;}));}
async function requestJson(url,timeout=10000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{const r=await fetch(`${url}${url.includes('?')?'&':'?'}v=${Date.now()}`,{cache:"no-store",signal:controller.signal});
    if(!r.ok)throw Error(`HTTP ${r.status} ${url}`);return await r.json();
  }finally{clearTimeout(timer);}
}
async function requestLiveJson(relative){
  const base=String(window.BOAT_CHECK_LIVE_BASE||"").replace(/\/$/,"");
  if(base){try{return await requestJson(`${base}/${relative.replace(/^data\//,"")}`,4000);}catch(error){console.warn("LIVE endpoint unavailable; using published snapshot",error);}}
  return requestJson(relative);
}
async function ensureVenue(code){
  if(bcSelectedOffset!==0)return;
  if(homeLoadPromise)await homeLoadPromise;
  if(loadedVenues.has(code))return;
  const meeting=await requestLiveJson(`data/venue/${code}.json`);
  if(String(meeting.date)!==state.dateJST)throw Error("場データの日付が一致しません");
  const idx=state.meetings.findIndex(m=>m.venueCode===code);
  if(idx<0)throw Error("開催場が見つかりません");
  state.meetings[idx]=meeting;
  loadedVenues.add(code);
}
function mergeVenueLive(meeting,live){
  if(!meeting||String(meeting.date)!==String(live?.date))return false;
  const map=new Map((live.races||[]).map(r=>[Number(r.raceNo),r]));
  for(const race of meeting.races||[]){
    const fresh=map.get(Number(race.raceNo));if(!fresh)continue;
    for(const [key,value] of Object.entries(fresh))if(key!=="boats" && value!==undefined)race[key]=value;
    const boats=new Map((fresh.boats||[]).map(b=>[Number(b.lane),b]));
    for(const boat of race.boats||[]){
      const update=boats.get(Number(boat.lane));
      if(update&&String(update.racerId||update.registrationNo)===String(boat.racerId||boat.registrationNo))Object.assign(boat,update);
    }
  }
  return true;
}
function hasPendingDemoBets(){
  try{return (JSON.parse(localStorage.getItem("boatCheckDemoHistory")||"[]")||[]).some(h=>(h.bets||[]).some(b=>b.settled!==true));}
  catch{return false;}
}
async function loadSettlements(){
  if(!hasPendingDemoBets()||Date.now()-settlementLoadAt<55000)return;
  try{const data=await requestLiveJson("data/settlements.json");
    if(data.dateJST!==state.dateJST)return;
    state.recentResults=Array.isArray(data.recentResults)?data.recentResults:[];
    settlementLoadAt=Date.now();demoSettleHistoryFromOfficialResults();
  }catch(error){console.warn("Settlement data unavailable",error);}
}
let homeActiveTab="venues";
let homeMyPageTab="bets";
let homeBetHistoryTab="recent";
let homeHistoryOpenGroups=new Set();
let motorInnerTab="motor";
let currentQuickDataType="";
let homeFavoriteQuery="";


function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function gradeClass(g){return g==="SG"?"sg":g==="G1"?"g1":g==="G2"?"g2":g==="G3"?"g3":g==="女子"?"women":"general"}
function displayGrade(m){return meetingGrade(m)}
function jstNow(){
  const parts=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());
  const o=Object.fromEntries(parts.map(x=>[x.type,x.value]));return {date:`${o.year}${o.month}${o.day}`,time:`${o.hour}:${o.minute}`}
}
function raceIsPast(deadline, nowTime){
  const toMinutes=v=>{
    const m=String(v||"").match(/^(\d{1,2}):(\d{2})$/);
    return m?Number(m[1])*60+Number(m[2]):null;
  };
  const d=toMinutes(deadline), n=toMinutes(nowTime);
  return d!==null&&n!==null&&d<=n;
}

function normalizeCancelStatus(v){
  const s=String(v||"").toLowerCase();
  if(["postponed","suspended","cancel_postponed"].includes(s)) return "postponed";
  if(["cancelled","canceled","abandoned","cancel"].includes(s)) return "cancelled";
  if(["partial_cancelled","partial_canceled","partial"].includes(s)) return "partial_cancelled";
  return "";
}
function raceCancelStatus(r){
  if(!r)return "";
  const direct=normalizeCancelStatus(r.status||r.raceStatus||r.state);
  if(direct)return direct;
  const text=`${r.statusLabel||""} ${r.note||""} ${r.message||""}`;
  if(/中止順延|順延/.test(text))return "postponed";
  if(/中止|不成立|発売中止/.test(text))return "cancelled";
  return "";
}
function meetingCancelStatus(m){
  if(!m)return "";
  const direct=normalizeCancelStatus(m.status||m.meetingStatus||m.state);
  if(direct)return direct;
  const text=`${m.statusLabel||""} ${m.note||""} ${m.message||""} ${m.title||""}`;
  if(/中止順延/.test(text))return "postponed";
  if(/開催中止|全レース中止|中止打切|打ち切り/.test(text))return "cancelled";
  const races=m.races||[];
  if(races.some(r=>raceCancelStatus(r)))return "partial_cancelled";
  return "";
}
function raceIsCancelled(r){
  return !!raceCancelStatus(r);
}
function liveRaces(m){
  return (m?.races||[]).filter(r=>!raceIsCancelled(r));
}
function cancellationLabel(status){
  if(status==="postponed")return "中止順延";
  if(status==="cancelled")return "開催中止";
  if(status==="partial_cancelled")return "一部レース中止";
  return "";
}

function getNextRace(m){
  const now=jstNow();
  const available=liveRaces(m);
  if(m.date<now.date)return null;
  if(m.date!==now.date)return available[0]||null;
  return available.find(r=>r.deadline && !raceIsPast(r.deadline,now.time))||null;
}
function formatDataDate(s){
  if(!s||s.length!==8)return "";
  const d=new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",year:"numeric",month:"long",day:"numeric",weekday:"short"}).format(d);
}
function formatUpdated(s){
  if(!s)return "更新時刻不明";
  try{return new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit"}).format(new Date(s))+" 更新"}catch{return "更新済み"}
}
function dataFreshnessLabel(s){
  const age=(Date.now()-new Date(s).getTime())/60000;
  return Number.isFinite(age)&&age>20?`更新遅延・${formatUpdated(s)}`:formatUpdated(s);
}
function renderLoading(){
  if($("venues").querySelectorAll(".card").length===24)return;
  if($("venues").dataset.snapshotDate===jstNow().date)return;
  $("venues").innerHTML=VENUES.map(v=>`<div class="card"><div class="name skeleton">${v[1]}</div><div class="meta skeleton">読込中</div><div class="race skeleton">----</div></div>`).join("");
}
function minutesUntil(deadline){
  if(!deadline)return null;
  const nowParts=jstNow(), [h,m]=deadline.split(":").map(Number), [nh,nm]=nowParts.time.split(":").map(Number);
  return h*60+m-(nh*60+nm);
}
function countdownText(deadline){
  const mins=minutesUntil(deadline);
  if(mins===null)return "";
  // 締切予定時刻と同じ分になった時点で受付終了扱いにする。
  if(mins<=0)return "締切済";
  if(mins<60)return `締切まで ${mins}分`;
  return `締切まで ${Math.floor(mins/60)}時間${mins%60?mins%60+"分":""}`;
}
function meetingState(m,next){
  const cancel=meetingCancelStatus(m);
  if(cancel==="postponed")return {cls:"postponed",label:"中止順延",card:"isPostponed"};
  if(cancel==="cancelled")return {cls:"cancelled",label:"開催中止",card:"isCancelled"};
  const now=jstNow();
  if(m.date<now.date)return {cls:"closed",label:"開催終了",card:"isClosed"};
  if(m.date!==now.date)return {cls:"soon",label:"開始前",card:"isSoon"};
  if(!next){
    if(cancel==="partial_cancelled")return {cls:"partial",label:"一部レース中止",card:"isPartialCancelled"};
    return {cls:"closed",label:"本日終了",card:"isClosed"};
  }
  const first=liveRaces(m)[0];
  if(first && first.deadline && !raceIsPast(first.deadline,now.time) && next.raceNo===first.raceNo)return {cls:"soon",label:"開始前",card:"isSoon"};
  return {cls:"live",label:"開催中",card:cancel==="partial_cancelled"?"isPartialCancelled":"isLive"};
}
function meetingGrade(m){
  const direct=String(m.grade||"").toUpperCase();
  return m.gradeVerified && ["SG","G1","G2","G3","一般"].includes(direct)?direct:"確認中";
}
function normTitle(m){return `${m.title||""} ${m.raceType||""}`.replace(/\s+/g,"");}
function timeMark(m){
  const races=m.races||[];
  const first=races.find(r=>Number(r.raceNo)===1)||races[0];
  if(!first || !first.deadline)return null;

  const [h,min]=first.deadline.split(":").map(Number);
  const total=h*60+min;

  // User-defined classification based on 1R time.
  if(total>=510 && total<=540)return ["morning","","モーニング"];   // 08:30-09:00
  if(total>=680 && total<=780)return ["summer","","サマータイム"]; // 11:20-13:00
  if(total>=900 && total<=960)return ["night","","ナイター"];      // 15:00-16:00
  if(total>=1020 && total<=1080)return ["midnight","","ミッドナイト"]; // 17:00-18:00
  return null;
}
function timeClass(m){
  const tm=timeMark(m);
  return tm ? `time-${tm[0]}` : "time-other";
}
function eventMarks(m){
  const title=normTitle(m), marks=[];
  const tm=timeMark(m);
  if(tm)marks.push(`<span class="mark ${tm[0]}" aria-label="${tm[2]}">${tm[1]}</span>`);
  if(/オールレディース|ヴィーナスシリーズ|レディースオールスター|クイーンズクライマックス|クイーン|QUEEN|レディースチャレンジカップ/.test(title))marks.push(`<span class="mark women" aria-label="女子戦">♥</span>`);
  const grade=meetingGrade(m);
  if(["G3","G2","G1","SG"].includes(grade))marks.push(`<span class="gradeMark ${grade.toLowerCase()}">${grade}</span>`);
  return marks.join("");
}

function homeFormatPt(v){
  return `${Number(v||0).toLocaleString("ja-JP")}pt`;
}
function homeFormatDateTime(iso){
  if(!iso)return "--";
  try{
    return new Intl.DateTimeFormat("ja-JP",{
      timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"
    }).format(new Date(iso));
  }catch(e){return "--";}
}
function homeLoadJson(key,fallback){
  try{
    const v=JSON.parse(localStorage.getItem(key)||"null");
    return v===null?fallback:v;
  }catch(e){return fallback;}
}
function homeSaveJson(key,value){
  localStorage.setItem(key,JSON.stringify(value));
}
function homeFavorites(){
  const list=homeLoadJson("boatCheckFavoriteRacers",[]);
  return Array.isArray(list)?list:[];
}
function homeSetFavorites(list){
  homeSaveJson("boatCheckFavoriteRacers",list);
}
function homeNormalizeRacerName(v){
  return cleanRacerName(v||"").replace(/\s+/g,"");
}
function homeAllRacers(){
  const map=new Map();
  (state.meetings||[]).forEach(m=>{
    (m.races||[]).forEach(r=>{
      (r.boats||[]).forEach(b=>{
        const id=String(b.racerId||b.registrationNo||"").trim();
        if(!id)return;
        const name=cleanRacerName(b.racerName||"");
        if(!map.has(id)){
          map.set(id,{
            racerId:id,
            racerName:name||"--",
            class:b.class||"--",
            branch:b.branch||b.region||"--",
            period:b.period||null
          });
        }
      });
    });
  });
  return [...map.values()].sort((a,b)=>a.racerId.localeCompare(b.racerId));
}
function homeIsFavorite(racerId){
  const id=String(racerId||"");
  return homeFavorites().some(x=>String(x.racerId)===id);
}
function homeToggleFavorite(racerId){
  const id=String(racerId||"");
  const racers=homeAllRacers();
  const racer=racers.find(x=>String(x.racerId)===id) || homeFavorites().find(x=>String(x.racerId)===id);
  if(!racer)return;

  let list=homeFavorites();
  if(list.some(x=>String(x.racerId)===id)){
    list=list.filter(x=>String(x.racerId)!==id);
    demoToast("お気に入りから解除しました");
  }else{
    list=[...list,{...racer,addedAt:new Date().toISOString()}];
    demoToast("お気に入りに登録しました");
  }
  homeSetFavorites(list);
  renderHomeFavorites();
  if(homeActiveTab==="mypage"&&homeMyPageTab==="favorites")renderHomeMyPage();
}
function homeFavoriteRuns(){
  const favIds=new Set(homeFavorites().map(x=>String(x.racerId)));
  const rows=[];
  (state.meetings||[]).forEach(m=>{
    (m.races||[]).forEach(r=>{
      (r.boats||[]).forEach(b=>{
        const id=String(b.racerId||b.registrationNo||"");
        if(!favIds.has(id))return;
        const mins=minutesUntil(r.deadline);
        rows.push({
          venueCode:m.venueCode,
          venueName:m.venueName||VENUES.find(v=>v[0]===m.venueCode)?.[1]||"--",
          day:m.day||"",
          grade:meetingGrade(m),
          raceNo:Number(r.raceNo)||0,
          deadline:r.deadline||"--:--",
          mins,
          lane:Number(b.lane)||0,
          racerId:id,
          racerName:cleanRacerName(b.racerName||""),
          class:b.class||"--",
          cancelled:raceIsCancelled(r)
        });
      });
    });
  });
  return rows.sort((a,b)=>{
    const am=(a.mins===null?9999:a.mins), bm=(b.mins===null?9999:b.mins);
    return am-bm || a.venueCode.localeCompare(b.venueCode) || a.raceNo-b.raceNo;
  });
}
function homeOpenRace(code,raceNo){
  openVenue(code);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    jumpRace(Number(raceNo),"instant","center");
  }));
}
function homeOpenRaceDetail(code,raceNo){
  openVenue(code);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    openRace(Number(raceNo));
  }));
}
function renderHomePointBalance(){
  const el=$("homePtBalanceValue");
  if(el && typeof demoPoints!=="undefined")el.textContent=homeFormatPt(demoPoints);
}
function setHomeTab(tab){
  homeActiveTab=tab||"venues";
  document.querySelectorAll("#homeTabs .homeTab").forEach(el=>{
    el.classList.toggle("active",el.dataset.homeTab===homeActiveTab);
  });

  ["homeVenuesPanel","homeDeadlinePanel","homeFavoritesPanel","homeMyPagePanel"].forEach(id=>$(id)?.classList.add("hidden"));
  if(homeActiveTab==="venues")$("homeVenuesPanel")?.classList.remove("hidden");
  if(homeActiveTab==="deadline"){
    $("homeDeadlinePanel")?.classList.remove("hidden");
    renderHomeDeadline();
  }
  if(homeActiveTab==="favorites"){
    $("homeFavoritesPanel")?.classList.remove("hidden");
    renderHomeFavorites();
  }
  if(homeActiveTab==="mypage"){
    $("homeMyPagePanel")?.classList.remove("hidden");
    renderHomeMyPage();
  }
  renderHomePointBalance();
  scrollTo({top:0,behavior:"instant"});
}
function renderHomeDeadline(){
  const panel=$("homeDeadlinePanel");
  if(!panel)return;
  const now=jstNow();

  const allUpcoming=[];
  (state.meetings||[]).forEach(m=>{
    if(m.date!==now.date)return;
    const cancel=meetingCancelStatus(m);
    if(cancel==="cancelled"||cancel==="postponed")return;

    (m.races||[]).forEach(r=>{
      if(raceIsCancelled(r))return;
      const mins=minutesUntil(r.deadline);
      if(mins===null||mins<=0)return;
      allUpcoming.push({
        venueCode:m.venueCode,
        venueName:m.venueName||VENUES.find(v=>v[0]===m.venueCode)?.[1]||"--",
        day:m.day||"",
        grade:meetingGrade(m),
        raceNo:Number(r.raceNo)||0,
        deadline:r.deadline||"--:--",
        mins,
        partial:cancel==="partial_cancelled",
        title:m.title||m.eventTitle||"",
        timeType:timeMark(m)
      });
    });
  });

  allUpcoming.sort((a,b)=>a.mins-b.mins || a.venueCode.localeCompare(b.venueCode) || a.raceNo-b.raceNo);

  const picked=[];
  const seenVenue=new Set();
  allUpcoming.forEach(x=>{
    if(picked.length>=10)return;
    if(!seenVenue.has(x.venueCode)){
      picked.push(x);
      seenVenue.add(x.venueCode);
    }
  });

  if(picked.length<10){
    const used=new Set(picked.map(x=>`${x.venueCode}:${x.raceNo}`));
    allUpcoming.forEach(x=>{
      if(picked.length>=10)return;
      const key=`${x.venueCode}:${x.raceNo}`;
      if(!used.has(key)){
        picked.push(x);
        used.add(key);
      }
    });
    picked.sort((a,b)=>a.mins-b.mins || a.venueCode.localeCompare(b.venueCode) || a.raceNo-b.raceNo);
  }

  panel.innerHTML=`<div class="homeListPage deadlinePremiumPage">
    <div class="deadlineHero">
      <div>
        <span class="deadlineEyebrow">CLOSE ORDER</span>
        <h3>締切順</h3>
        <p>締切が近いレースをリアルタイム順で表示</p>
      </div>
      <div class="deadlineHeroBadge">
        <strong>${picked.length}</strong>
        <span>RACES</span>
      </div>
    </div>

    ${picked.length?`<div class="deadlinePremiumList">
      ${picked.map((x,i)=>{
        const urgent=x.mins<=10;
        const soon=x.mins<=20;
        const stateClass=urgent?"urgent":soon?"soon":"normal";
        const remain=`あと${x.mins}分`;
        const gradeClass=String(x.grade||"").toLowerCase().replace(/\s+/g,"");
        return `<button class="deadlinePremiumRow ${stateClass}" onclick="homeOpenRace('${x.venueCode}',${x.raceNo})">
          <div class="deadlineTopLine">
            <div class="deadlineOrderNo">${String(i+1).padStart(2,"0")}</div>
            <div class="deadlineVenueBlock">
              <div class="deadlineVenueNameLine">
                <strong>${esc(x.venueName)}</strong>
                <span class="deadlineGrade grade-${gradeClass}">${esc(x.grade)}</span>
                ${x.partial?`<span class="deadlinePartial">一部中止</span>`:""}
              </div>
              <small>${esc(x.day)}${x.title?` ・ ${esc(x.title)}`:""}</small>
            </div>
            <div class="deadlineRaceBlock">
              <strong>${x.raceNo}<small>R</small></strong>
              <span>締切予定</span>
            </div>
          </div>

          <div class="deadlineBottomLine">
            <div class="deadlineStatusDot"></div>
            <div class="deadlineRemain">${remain}</div>
            <div class="deadlineProgressTrack">
              <span style="width:${Math.max(8,Math.min(100,100-(x.mins*1.4)))}%"></span>
            </div>
            <div class="deadlineClock">${esc(x.deadline)}</div>
            <div class="deadlineChevron">›</div>
          </div>
        </button>`;
      }).join("")}
    </div>`:`<div class="homeEmptyState"><b>締切前のレースはありません</b><span>開催データが更新されると自動で表示します。</span></div>`}
  </div>`;
}
function updateHomeFavoriteSearch(q){
  homeFavoriteQuery=String(q||"");
  const root=$("favoriteSearchResults");
  if(!root)return;
  const query=homeFavoriteQuery.trim().toLowerCase().replace(/\s+/g,"");
  if(!query){
    root.innerHTML=`<div class="favoriteSearchHint">選手名または4桁の登録番号を入力してください。</div>`;
    return;
  }
  const matches=homeAllRacers().filter(r=>{
    const name=homeNormalizeRacerName(r.racerName).toLowerCase();
    const id=String(r.racerId||"");
    return name.includes(query)||id.includes(query);
  }).slice(0,20);

  root.innerHTML=matches.length?matches.map(r=>{
    const fav=homeIsFavorite(r.racerId);
    return `<div class="favoriteSearchRow">
      <button class="favoriteStar ${fav?"active":""}" onclick="homeToggleFavorite('${esc(r.racerId)}')" aria-label="お気に入り">${fav?"★":"☆"}</button>
      <div class="favoritePlayer">
        <strong>${esc(r.racerName||"--")}</strong>
        <span>${esc(r.racerId)} / ${esc(r.class||"--")} / ${esc(r.branch||"--")}${r.period?` / ${esc(r.period)}期`:""}</span>
      </div>
    </div>`;
  }).join(""):`<div class="favoriteSearchHint">本日の出走データから該当選手が見つかりません。</div>`;
}
function renderHomeFavorites(){
  const panel=$("homeFavoritesPanel");
  if(!panel)return;
  const favs=homeFavorites();
  const runs=homeFavoriteRuns();

  panel.innerHTML=`<div class="homeListPage">
    <div class="homePanelTitle">
      <div><h3>お気に入り</h3><p>登録選手の本日の出走をまとめて確認</p></div>
      <span>${favs.length}人登録</span>
    </div>

    <div class="favoriteSearchBox">
      <label>選手を検索してお気に入り登録</label>
      <div class="favoriteSearchInput">
        <span>⌕</span>
        <input id="favoriteSearchInput" type="search" autocomplete="off" placeholder="選手名・登録番号で検索"
          value="${esc(homeFavoriteQuery)}" oninput="updateHomeFavoriteSearch(this.value)">
      </div>
      <div id="favoriteSearchResults"></div>
    </div>

    <div class="favoriteSectionHead">
      <b>お気に入り選手の本日レース</b>
      <span>${runs.length}件</span>
    </div>

    ${!favs.length?`<div class="homeEmptyState">
      <b>お気に入り選手がまだ登録されていません</b>
      <span>上の検索欄から選手を探して☆をタップしてください。</span>
    </div>`:runs.length?`<div class="favoriteRuns">
      ${runs.map(x=>`<button class="favoriteRun ${x.cancelled?"cancelled":""}" onclick="homeOpenRaceDetail('${x.venueCode}',${x.raceNo})">
        <div class="favoriteRunLane lane${x.lane}">${x.lane}</div>
        <div class="favoriteRunPlayer">
          <strong>${esc(x.racerName)}</strong>
          <span>${esc(x.racerId)} / ${esc(x.class)}</span>
        </div>
        <div class="favoriteRunRace">
          <b>${esc(x.venueName)} ${x.raceNo}R</b>
          <span>${x.cancelled?"中止":`締切 ${esc(x.deadline)}`}</span>
        </div>
        <div class="deadlineArrow">›</div>
      </button>`).join("")}
    </div>`:`<div class="homeEmptyState">
      <b>お気に入り選手の本日の出走はありません</b>
      <span>出走がある日に自動でここへ表示されます。</span>
    </div>`}
  </div>`;

  updateHomeFavoriteSearch(homeFavoriteQuery);
}
function homeBetHistory(){
  const h=homeLoadJson("boatCheckDemoHistory",[]);
  return Array.isArray(h)?h:[];
}
function homePtHistory(){
  const h=homeLoadJson("boatCheckPtHistory",[]);
  return Array.isArray(h)?h:[];
}
function homeAddPoints(v){
  let amount=Math.floor(Number(v)||0);
  if(amount<=0){
    alert("追加するptを入力してください。");
    return;
  }
  demoPoints+=amount;
  demoSavePoints();

  const hist=homePtHistory();
  hist.unshift({
    at:new Date().toISOString(),
    amount,
    balance:demoPoints,
    type:"add"
  });
  homeSaveJson("boatCheckPtHistory",hist.slice(0,200));
  renderHomePointBalance();
  renderHomeMyPage();
  demoToast(`${amount.toLocaleString("ja-JP")}pt追加しました`);
}
function homeAddCustomPoints(){
  const input=$("myPointCustomInput");
  if(!input)return;
  homeAddPoints(input.value);
}
function setHomeMyPageTab(tab){
  homeMyPageTab=tab;
  renderHomeMyPage();
}
function setHomeBetHistoryTab(tab){
  homeBetHistoryTab=tab;
  renderHomeMyPage();
}
function homeFlattenHistory(limit=999){
  const out=[];
  homeBetHistory().forEach((h,hi)=>{
    const bets=Array.isArray(h.bets)?h.bets:[];
    bets.forEach((b,bi)=>{
      out.push({
        at:h.at,
        receiptNo:h.receiptNo||String(hi+1).padStart(4,"0"),
        venueName:b.venueName||h.venue||"--",
        raceNo:b.raceNo||h.raceNo||"--",
        type:b.type||"",
        combo:Array.isArray(b.combo)?b.combo:[],
        stake:Number(b.stake)||0,
        odds:b.odds,
        hit:b.hit===true||b.isHit===true||b.result==="hit",
        refunded:b.refunded===true||b.status==="refund",
        settled:b.settled===true,
        status:b.status||"",
        officialPayout:Number(b.officialPayout||0),
        payout:Number(b.payout||0)
      });
    });
  });
  return out.slice(0,limit);
}
function homeHistoryGroupKey(x){
  return `${x.venueName||"--"}:${x.raceNo||"--"}:${(x.at||"").slice(0,10)}`;
}
function homeToggleHistoryGroup(key){
  if(homeHistoryOpenGroups.has(key))homeHistoryOpenGroups.delete(key);
  else homeHistoryOpenGroups.add(key);
  renderHomeMyPage();
}
function homeHistoryRows(mode){
  let rows=[];
  let recentMeta=null;

  if(mode==="recent"){
    const history=homeBetHistory();
    const latest=history[0]||null;

    if(latest){
      const bets=Array.isArray(latest.bets)?latest.bets:[];
      rows=bets.map((b,bi)=>({
        at:latest.at,
        receiptNo:latest.receiptNo||"0001",
        venueName:b.venueName||latest.venue||"--",
        raceNo:b.raceNo||latest.raceNo||"--",
        type:b.type||"",
        combo:Array.isArray(b.combo)?b.combo:[],
        stake:Number(b.stake)||0,
        odds:b.odds,
        hit:b.hit===true||b.isHit===true||b.result==="hit",
        refunded:b.refunded===true||b.status==="refund",
        settled:b.settled===true,
        status:b.status||"",
        officialPayout:Number(b.officialPayout||0),
        payout:Number(b.payout||0)
      }));
      recentMeta={
        at:latest.at,
        receiptNo:latest.receiptNo||"",
        total:Number(latest.total)||rows.reduce((s,x)=>s+x.stake,0),
        count:rows.length
      };
    }
  }else{
    rows=homeFlattenHistory();
    if(mode==="hit")rows=rows.filter(x=>x.hit||x.payout>0);
  }

  if(!rows.length){
    return `<div class="myEmpty">${
      mode==="hit"?"的中結果はまだありません。結果データ連携後に自動表示します。":
      mode==="recent"?"直前のベットリストはまだありません。":
      "デモ投票履歴はまだありません。"
    }</div>`;
  }

  const groupsMap=new Map();
  rows.forEach(x=>{
    const key=homeHistoryGroupKey(x);
    if(!groupsMap.has(key)){
      groupsMap.set(key,{
        key,
        venueName:x.venueName,
        raceNo:x.raceNo,
        at:x.at,
        receiptNo:x.receiptNo,
        bets:[]
      });
    }
    groupsMap.get(key).bets.push(x);
  });

  const groups=[...groupsMap.values()].sort((a,b)=>new Date(b.at)-new Date(a.at));

  return `${mode==="recent"&&recentMeta?`
    <div class="recentBetListSummary">
      <div>
        <small>直前に投票したベットリスト</small>
        <strong>${homeFormatDateTime(recentMeta.at)}</strong>
      </div>
      <div>
        <small>${recentMeta.receiptNo?`受付 ${esc(recentMeta.receiptNo)} / `:""}${recentMeta.count}点</small>
        <strong>${homeFormatPt(recentMeta.total)}</strong>
      </div>
    </div>`:""}
    <div class="myHistoryGroups">
    ${groups.map((g,idx)=>{
      const isOpen=homeHistoryOpenGroups.has(g.key);
      const totalStake=g.bets.reduce((s,x)=>s+x.stake,0);
      const totalPayout=g.bets.reduce((s,x)=>s+x.payout,0);
      const hitCount=g.bets.filter(x=>x.hit).length;
      const refundCount=g.bets.filter(x=>x.refunded).length;
      const pendingCount=g.bets.filter(x=>!x.settled).length;
      const groupStatus=pendingCount
        ? `<div class="myHistoryStatusBadge pending">結果待ち ${pendingCount}</div>`
        : hitCount
          ? `<div class="myHistoryStatusBadge hit">的中 ${hitCount}</div>`
          : refundCount===g.bets.length
            ? `<div class="myHistoryStatusBadge refund">返還</div>`
            : `<div class="myHistoryStatusBadge miss">確定</div>`;
      return `<div class="myHistoryGroup ${isOpen?"open":""} ${hitCount?"hasHit":""}">
        <button class="myHistoryGroupHead" onclick="homeToggleHistoryGroup('${g.key.replace(/'/g,"\\'")}')">
          <div class="myHistoryGroupVenue">
            <strong>${esc(g.venueName)} ${esc(g.raceNo)}R</strong>
            <span>${homeFormatDateTime(g.at)}${g.receiptNo?` / 受付 ${esc(g.receiptNo)}`:""}</span>
          </div>
          <div class="myHistoryGroupSummary">
            <b>${g.bets.length}点</b>
            <span>${homeFormatPt(totalStake)}</span>
          </div>
          ${groupStatus}
          <div class="myHistoryAccordionIcon">${isOpen?"−":"＋"}</div>
        </button>

        ${isOpen?`<div class="myHistoryGroupBody">
          <div class="myHistoryGroupTotals">
            <span>投資 <b>${homeFormatPt(totalStake)}</b></span>
            <span>払戻 <b>${homeFormatPt(totalPayout)}</b></span>
            <span>収支 <b class="${totalPayout-totalStake>=0?"plus":"minus"}">${totalPayout-totalStake>=0?"+":""}${homeFormatPt(totalPayout-totalStake)}</b></span>
          </div>
          ${g.bets.map(x=>`<div class="myHistoryBetRow ${x.hit?"isHit":""}">
            <div class="myHistoryBetType">${demoBetLabel(x.type)}</div>
            <div class="myHistoryBetCombo">${x.combo.length?oddsComboHtml(x.combo):"--"}</div>
            <div class="myHistoryBetAmount">
              <strong>${homeFormatPt(x.stake)}</strong>
              <small class="betStatus ${x.refunded?"refund":x.hit?"hit":x.settled?"miss":"pending"}">${demoSettlementStatusText(x)}</small>
              ${x.payout>0?`<small class="betPayout">${x.refunded?"返還":"払戻"} ${homeFormatPt(x.payout)}</small>`:""}
            </div>
          </div>`).join("")}
        </div>`:""}
      </div>`;
    }).join("")}
  </div>`;
}
function homeRenderBetInquiry(){
  const totalRows=homeFlattenHistory();
  const totalStake=totalRows.reduce((s,x)=>s+x.stake,0);
  const totalPayout=totalRows.reduce((s,x)=>s+x.payout,0);
  const hits=totalRows.filter(x=>x.hit||x.payout>0).length;

  return `<div class="myPageSection">
    <div class="myStatGrid">
      <div><small>投票数</small><strong>${totalRows.length}点</strong></div>
      <div><small>総投資</small><strong>${homeFormatPt(totalStake)}</strong></div>
      <div><small>総払戻</small><strong>${homeFormatPt(totalPayout)}</strong></div>
      <div><small>的中</small><strong>${hits}点</strong></div>
    </div>

    <button class="myCartOpen" onclick="demoOpenCart()">
      <span>現在のベットリスト</span>
      <strong>${typeof demoCart!=="undefined"?demoCart.length:0}点 ›</strong>
    </button>

    <div class="myHistoryTabs">
      <button class="${homeBetHistoryTab==="recent"?"active":""}" onclick="setHomeBetHistoryTab('recent')">直近の投票履歴</button>
      <button class="${homeBetHistoryTab==="all"?"active":""}" onclick="setHomeBetHistoryTab('all')">投票履歴</button>
      <button class="${homeBetHistoryTab==="hit"?"active":""}" onclick="setHomeBetHistoryTab('hit')">的中結果一覧</button>
    </div>
    ${homeHistoryRows(homeBetHistoryTab)}
  </div>`;
}
function homeRewardAdState(){
  const today=jstNow().date;
  let s=homeLoadJson("boatCheckRewardAdDaily",{date:today,count:0});
  if(!s || s.date!==today)s={date:today,count:0};
  return s;
}
function homeSaveRewardAdState(s){
  homeSaveJson("boatCheckRewardAdDaily",s);
}
function homeRewardAdRemaining(){
  return Math.max(0,5-homeRewardAdState().count);
}
let homeAdCountdownTimer=null;
let homeAdCountdown=0;

function homeWatchRewardAd(){
  demoToast("報酬付き広告は現在利用できません");
}
function homeCloseAdModal(){
  clearInterval(homeAdCountdownTimer);
  const el=$("homeAdModal");
  if(el)el.remove();
}
function renderHomeAdModal(){
  let wrap=$("homeAdModal");
  if(!wrap){
    wrap=document.createElement("div");
    wrap.id="homeAdModal";
    document.body.appendChild(wrap);
  }
  wrap.className="rewardAdBackdrop";
  wrap.innerHTML=`<div class="rewardAdModal">
    <div class="rewardAdHead"><b>報酬付き広告</b><button onclick="homeCloseAdModal()">×</button></div>
    <div class="rewardAdMock">
      <span>AD</span>
      <strong>現在利用できません</strong>
      <small>正式な報酬付き広告の接続後に提供します</small>
    </div>
    <button class="rewardAdClaim" onclick="homeCloseAdModal()">閉じる</button>
  </div>`;
}
function homeGrantAdReward(){
  homeCloseAdModal();
  demoToast("報酬付き広告は現在利用できません");
}

function homeMissionDefinitions(){
  return [
    {
      id:"manshu",
      title:"万舟チャレンジ",
      desc:"オッズ100.0倍以上の買い目を的中",
      reward:1000,
      icon:"🎯"
    },
    {
      id:"two_tickets",
      title:"2点勝負",
      desc:"同じレースを2点以内で的中",
      reward:500,
      icon:"✌️"
    }
  ];
}
function homeMissionState(){
  const today=jstNow().date;
  let s=homeLoadJson("boatCheckDailyMissionState",{date:today,claimed:{}});
  if(!s || s.date!==today)s={date:today,claimed:{}};
  if(!s.claimed)s.claimed={};
  return s;
}
function homeMissionStatus(id){
  const today=jstNow().date;
  const histories=homeBetHistory();
  const raceGroups=new Map();

  histories.forEach(h=>{
    const date=(h.at||"").slice(0,10);
    // ISOはUTCのため、表示日がずれる可能性を避けるためJSTの日付も計算
    let jstDate="";
    try{
      jstDate=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"}).format(new Date(h.at));
    }catch(e){}
    if(jstDate!==today && date!==today)return;

    (h.bets||[]).forEach(b=>{
      const key=`${b.venueCode||b.venueName||h.venue||""}:${b.raceNo||h.raceNo||""}`;
      if(!raceGroups.has(key))raceGroups.set(key,[]);
      raceGroups.get(key).push(b);
    });
  });

  if(id==="manshu"){
    for(const bets of raceGroups.values()){
      for(const b of bets){
        const hit=b.hit===true||b.isHit===true||b.result==="hit";
        const officialPayout=Number(b.officialPayout||0);
        const odds=Number(b.odds||0);
        if(hit && (officialPayout>=10000 || odds>=100))return {done:true,progress:"達成"};
      }
    }
    return {done:false,progress:"0 / 1"};
  }

  if(id==="two_tickets"){
    for(const bets of raceGroups.values()){
      if(bets.length<=2 && bets.some(b=>b.hit===true||b.isHit===true||b.result==="hit"||Number(b.payout||0)>0)){
        return {done:true,progress:"達成"};
      }
    }
    return {done:false,progress:"0 / 1"};
  }

  return {done:false,progress:"0 / 1"};
}
function homeClaimMission(id){
  const def=homeMissionDefinitions().find(x=>x.id===id);
  if(!def)return;
  const status=homeMissionStatus(id);
  const stateM=homeMissionState();
  if(stateM.claimed[id]){
    demoToast("このミッションは受取済みです");
    return;
  }
  if(!status.done){
    demoToast("ミッションはまだ達成していません");
    return;
  }

  stateM.claimed[id]=true;
  homeSaveJson("boatCheckDailyMissionState",stateM);
  demoPoints+=def.reward;
  demoSavePoints();

  const hist=homePtHistory();
  hist.unshift({
    at:new Date().toISOString(),
    amount:def.reward,
    balance:demoPoints,
    type:"mission",
    label:def.title
  });
  homeSaveJson("boatCheckPtHistory",hist.slice(0,200));
  renderHomeMyPage();
  renderHomePointBalance();
  demoToast(`${def.title} +${def.reward.toLocaleString("ja-JP")}pt`);
}
function homeRenderMissions(){
  const defs=homeMissionDefinitions();
  const ms=homeMissionState();
  return `<div class="dailyMissionBox">
    <div class="dailyMissionHead">
      <div><h4>本日のミッション</h4><span>毎日0:00にリセット</span></div>
      <b>${Object.keys(ms.claimed||{}).length}/${defs.length} 受取</b>
    </div>
    ${defs.map(d=>{
      const st=homeMissionStatus(d.id);
      const claimed=!!ms.claimed[d.id];
      return `<div class="dailyMissionRow ${st.done?"done":""}">
        <div class="missionIcon">${d.icon}</div>
        <div class="missionText">
          <strong>${esc(d.title)}</strong>
          <span>${esc(d.desc)}</span>
          <small>報酬 +${d.reward.toLocaleString("ja-JP")}pt</small>
        </div>
        <div class="missionAction">
          <span>${claimed?"受取済":st.progress}</span>
          <button ${(!st.done||claimed)?"disabled":""} onclick="homeClaimMission('${d.id}')">${claimed?"受取済":"受け取る"}</button>
        </div>
      </div>`;
    }).join("")}
    <div class="missionNote">※ 的中ミッションはレース結果が投票履歴へ反映された後に自動判定します。</div>
  </div>`;
}
function homeRenderPoints(){
  const hist=homePtHistory();
  const adState=homeRewardAdState();
  const remaining=Math.max(0,5-adState.count);

  return `<div class="myPageSection">
    <div class="myPointHero">
      <small>現在の所持pt</small>
      <strong>${homeFormatPt(demoPoints)}</strong>
      <span>デモ投票専用の仮想ポイント</span>
    </div>

    ${homeRenderMissions()}

    <div class="favoriteSectionHead"><b>pt獲得履歴</b><span>${hist.length}件</span></div>
    ${hist.length?`<div class="ptHistory">
      ${hist.slice(0,30).map(x=>`<div class="ptHistoryRow">
        <div>
          <strong>+${Number(x.amount||0).toLocaleString("ja-JP")}pt</strong>
          <small>${esc(x.label||(
            x.type==="reward_ad"?"広告視聴":
            x.type==="mission"?"本日のミッション":"pt追加"
          ))} ・ ${homeFormatDateTime(x.at)}</small>
        </div>
        <span>残高 ${homeFormatPt(x.balance)}</span>
      </div>`).join("")}
    </div>`:`<div class="myEmpty">pt獲得履歴はまだありません。</div>`}
  </div>`;
}
function homeRenderFavoriteManage(){
  const favs=homeFavorites();
  return `<div class="myPageSection">
    <div class="favoriteSectionHead"><b>お気に入り選手</b><span>${favs.length}人</span></div>
    ${favs.length?`<div class="myFavoriteManage">
      ${favs.map(r=>`<div class="myFavoriteRow">
        <button class="favoriteStar active" onclick="homeToggleFavorite('${esc(r.racerId)}')">★</button>
        <div><strong>${esc(r.racerName||"--")}</strong><span>${esc(r.racerId)} / ${esc(r.class||"--")} / ${esc(r.branch||"--")}</span></div>
        <button class="myRemoveFavorite" onclick="homeToggleFavorite('${esc(r.racerId)}')">解除</button>
      </div>`).join("")}
    </div>`:`<div class="myEmpty">お気に入り選手はまだ登録されていません。</div>`}
  </div>`;
}
function homeBackupData(){
  const payload={
    version:1,
    exportedAt:new Date().toISOString(),
    demoPoints,
    favorites:homeFavorites(),
    demoCart:typeof demoCart!=="undefined"?demoCart:[],
    demoHistory:homeBetHistory(),
    ptHistory:homePtHistory(),
    racerNotes:bcReadNotes()
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`boat-check-backup-${jstNow().date}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function homeRestoreData(input){
  const file=input?.files?.[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const d=JSON.parse(String(reader.result||"{}"));
      if(d.racerNotes)bcRestoreNotes(d.racerNotes);
      if(typeof d.demoPoints==="number"){
        demoPoints=d.demoPoints;
        demoSavePoints();
      }
      if(Array.isArray(d.favorites))homeSetFavorites(d.favorites);
      if(Array.isArray(d.demoCart)){
        demoCart=d.demoCart;
        demoPersistCart();
      }
      if(Array.isArray(d.demoHistory))homeSaveJson("boatCheckDemoHistory",d.demoHistory);
      if(Array.isArray(d.ptHistory))homeSaveJson("boatCheckPtHistory",d.ptHistory);
      renderHomeMyPage();
      renderHomePointBalance();
      demoToast("バックアップを復元しました");
    }catch(e){
      alert("バックアップファイルを読み込めませんでした。");
    }finally{
      input.value="";
    }
  };
  reader.readAsText(file);
}
function homeClearUserData(){
  if(!confirm("お気に入り・投票履歴・ベットリスト・pt履歴を初期化しますか？"))return;
  localStorage.removeItem("boatCheckFavoriteRacers");
  localStorage.removeItem("boatCheckDemoCart");
  localStorage.removeItem("boatCheckDemoHistory");
  localStorage.removeItem("boatCheckPtHistory");
  localStorage.removeItem("boatCheckDemoPoints");
  demoPoints=10000;
  demoCart=[];
  demoPersistCart();
  demoSavePoints();
  renderHomeMyPage();
  renderHomePointBalance();
  demoToast("データを初期化しました");
}
function homeRenderDataManage(){
  return `<div class="myPageSection">
    <div class="myInfoCard">
      <strong>ゲスト利用中</strong>
      <span>現在のデータはこの端末のブラウザに保存されています。</span>
    </div>
    <div class="myDataActions">
      <button onclick="homeBackupData()"><b>バックアップ</b><span>データをJSONファイルに保存</span></button>
      <label><b>復元</b><span>バックアップファイルから復元</span>
        <input type="file" accept=".json,application/json" onchange="homeRestoreData(this)">
      </label>
      <button class="danger" onclick="homeClearUserData()"><b>データ初期化</b><span>端末内のデモデータを削除</span></button>
    </div>

  </div>`;
}
function renderHomeMyPage(){
  const panel=$("homeMyPagePanel");
  if(!panel)return;

  const body=homeMyPageTab==="bets"?homeRenderBetInquiry():
    homeMyPageTab==="points"?homeRenderPoints():
    homeMyPageTab==="favorites"?homeRenderFavoriteManage():
    homeRenderDataManage();

  panel.innerHTML=`<div class="homeListPage">
    <div class="homePanelTitle">
      <div><h3>マイページ</h3><p>デモ投票・pt・お気に入りを管理</p></div>
      <span class="guestBadge">ゲスト</span>
    </div>
    <div class="myBalanceBar">
      <span>所持pt</span>
      <strong>${homeFormatPt(demoPoints)}</strong>
    </div>
    <div class="myPageTabs">
      <button class="${homeMyPageTab==="bets"?"active":""}" onclick="setHomeMyPageTab('bets')">投票照会</button>
      <button class="${homeMyPageTab==="points"?"active":""}" onclick="setHomeMyPageTab('points')">pt追加</button>
      <button class="${homeMyPageTab==="favorites"?"active":""}" onclick="setHomeMyPageTab('favorites')">お気に入り管理</button>
      <button class="${homeMyPageTab==="data"?"active":""}" onclick="setHomeMyPageTab('data')">データ管理</button>
    </div>
    ${body}
  </div>`;
}
function refreshHomeActivePanel(){
  renderHomePointBalance();
  if(homeActiveTab==="deadline")renderHomeDeadline();
  if(homeActiveTab==="favorites")renderHomeFavorites();
  if(homeActiveTab==="mypage")renderHomeMyPage();
}

function renderVenues(){
  const overview=$("dailyOverview");
  if(overview){
    overview.hidden=bcSelectedOffset!==0;
    const s=state.dailyOverview;
    if(s&&bcSelectedOffset===0)overview.innerHTML=[
      ["開催",s.venues,"場"],["結果公開",s.ended,"R"],["展示更新",s.exhibition,"R"],
      ["風速6m以上",s.strongWind,"R"],["展示進入変更",s.courseChanges,"R"]
    ].map(([label,value,unit])=>`<span>${label} <b>${esc(value)}</b>${unit}</span>`).join("");
  }
  if(bcRenderDayStatus())return;
  const map=new Map(bcHomeMeetings().map(m=>[m.venueCode,m]));
  const now=jstNow();

  $("venues").innerHTML=VENUES.map(([code,name])=>{
    const m=map.get(code);

    if(!m){
      return `<div class="card off">
        <div class="nameRow">
          <span class="leftMark"></span>
          <div class="venueTitle">${name}</div>
          <span class="rightMark"></span>
        </div>
        <div class="offtext"><b>${bcAbsentLabel(code)}</b></div>
      </div>`;
    }

    const next=getNextRace(m);
    const st=meetingState(m,next);
    const cancelStatus=meetingCancelStatus(m);
    const title=normTitle(m);
    const grade=meetingGrade(m);
    const tm=timeMark(m);

    const left = tm
      ? `<span class="mark ${tm[0]}" aria-label="${tm[2]}">${tm[1]}</span>`
      : "";

    const right = /オールレディース|ヴィーナスシリーズ|レディースオールスター|クイーンズクライマックス|クイーン|QUEEN|レディースチャレンジカップ/.test(title)
      ? `<span class="mark women" aria-label="女子戦">♥</span>`
      : "";

    const gradeChip = grade==="一般"
      ? `<span class="kindText">一般</span>`
      : `<span class="gradeCenter ${grade.toLowerCase()}">${grade}</span>`;

    if(cancelStatus==="postponed" || cancelStatus==="cancelled"){
      return `<div class="card ${st.card} ${timeClass(m)} cancelledMeeting" data-code="${code}" onclick="openVenue('${code}')">
        <div class="nameRow">
          <span class="leftMark">${left}</span>
          <div class="venueTitle">${name}</div>
          <span class="rightMark">${right}</span>
        </div>
        <div class="meta">
          ${gradeChip}
          <span>${esc(m.day||"")}</span>
        </div>
        <div class="cancelMain">${cancelStatus==="postponed"?"中止順延":"開催中止"}</div>
        <div class="cancelSub">${cancelStatus==="postponed"?"開催日程変更":"本日の開催中止"}</div>
      </div>`;
    }

    if(!next){
      return `<div class="card ${st.card} ${timeClass(m)} todayEnded ${cancelStatus==="partial_cancelled"?"partialEnded":""}" data-code="${code}" onclick="openVenue('${code}')">
        <div class="nameRow">
          <span class="leftMark">${left}</span>
          <div class="venueTitle">${name}</div>
          <span class="rightMark">${right}</span>
        </div>
        <div class="meta">
          ${gradeChip}
          <span>${esc(m.day||"")}</span>
        </div>
        <div class="nextRow endedRow">
          <div class="endText">${m.date<now.date?"開催終了":"本日終了"}</div>
        </div>
        <div class="countdown endedSpacer">全レース終了</div>
      </div>`;
    }

    const finished=(m.races||[]).filter(
      r=>m.date===now.date&&raceIsPast(r.deadline,now.time)
    ).length;
    const pct=Math.round(finished/Math.max(1,(m.races||[]).length)*100);
    const mins=m.date===now.date?minutesUntil(next.deadline):null;
    const urgent=mins!==null&&mins>=0&&mins<=10;

    return `<div class="card ${st.card} ${timeClass(m)}" data-code="${code}" onclick="openVenue('${code}')">
      <div class="nameRow">
        <span class="leftMark">${left}</span>
        <div class="venueTitle">${name}</div>
        <span class="rightMark">${right}</span>
      </div>
      <div class="meta">
        ${gradeChip}
        <span>${esc(m.day||"")}</span>
      </div>
      ${cancelStatus==="partial_cancelled"?`<div class="partialCancelBadge">一部レース中止</div>`:""}
      <div class="nextRow">
        <div class="nextRace"><b>${next.raceNo}R</b></div>
        <div class="cutoff" aria-label="締切時刻"><b class="${urgent?"urgentTime":""}">${esc(next.deadline)}</b></div>
      </div>
      <div class="countdown ${urgent?"urgent":""}">${m.date===now.date?esc(countdownText(next.deadline)):"翌日開催"}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

function mdLabel(date){
  if(!date||date.length!==8)return "--/--";
  return `${Number(date.slice(4,6))}/${Number(date.slice(6,8))}`;
}
function normalizedMeetDays(m){
  let days=[];
  if(Array.isArray(m.meetDays)&&m.meetDays.length){
    days=m.meetDays.map(d=>({
      date:String(d.date||""),
      label:d.label||d.day||"",
      day:d.day||d.label||"",
      races:Array.isArray(d.races)?d.races:[]
    })).filter(d=>d.date);
  }

  const currentDate=String(m?.date||"");
  if(currentDate && !days.some(d=>d.date===currentDate)){
    days.push({date:currentDate,label:m.day||"",day:m.day||"",races:m.races||[]});
  }
  if(!days.length && currentDate){
    days=[{date:currentDate,label:m.day||"",day:m.day||"",races:m.races||[]}];
  }

  days.sort((a,b)=>a.date.localeCompare(b.date));
  days=days.map((d,i)=>{
    let label=d.label||d.day||"";
    // Older collected JSON could have the current day missing/wrong. Infer a clear label from date order.
    if(!label || (d.date===currentDate && label==="初日" && i>0)){
      label=i===0?"初日":i===days.length-1?"最終日":`${i+1}日目`;
    }
    return {...d,label,day:label};
  });
  return days;
}
function updateVenueSelectedDayBanner(m,date){
  const days=normalizedMeetDays(m||{});
  const d=days.find(x=>String(x.date)===String(date))||{};
  const raw=String(date||"");
  const mm=raw.length>=8?Number(raw.slice(4,6)):"";
  const dd=raw.length>=8?Number(raw.slice(6,8)):"";
  const dateEl=$("venueSelectedDate");
  const dayEl=$("venueSelectedDayLabel");
  if(dateEl)dateEl.textContent=(mm&&dd)?`${mm}/${dd}`:"--/--";
  if(dayEl)dayEl.textContent=d.label||d.day||"開催日";
}
function renderMeetDayTabs(m, selectedDate){
  const wrap=$("meetDayTabs");
  const days=normalizedMeetDays(m);
  if(!days.length){wrap.innerHTML="";return;}
  wrap.innerHTML=days.map(d=>{
    const raw=String(d.date||"");
    const mm=raw.length>=8?Number(raw.slice(4,6)):"";
    const dd=raw.length>=8?Number(raw.slice(6,8)):"";
    const dateLabel=(mm&&dd)?`${mm}/${dd}`:"";
    const dayLabel=d.label||d.day||"";
    const active=raw===String(selectedDate||"");
    return `<button class="${active?"active":""}" onclick="selectMeetDay('${esc(raw)}')"><span class="meetDate">${esc(dateLabel)}</span><span class="meetLabel">${esc(dayLabel)}</span></button>`;
  }).join("");
  const activeBtn=wrap.querySelector("button.active");
  if(activeBtn)setTimeout(()=>activeBtn.scrollIntoView({behavior:"instant",inline:"center",block:"nearest"}),0);
}

function currentDayView(m,date){
  const d=normalizedMeetDays(m).find(x=>x.date===date);
  if(!d)return {...m};
  return {...m,date:d.date,day:d.day||d.label||m.day,races:d.races||[]};
}

function selectMeetDay(date){
  const m=state.currentMeeting||state.currentMeetingView;
  if(!m)return;

  state.currentDayDate=date;
  const view=currentDayView(m,date);
  state.currentMeetingView=view;

  renderMeetDayTabs(m,date);
  updateVenueSelectedDayBanner(m,date);

  const next=getNextRace(view);
  $("venueName").textContent=m.venueName||"";
  $("venueInfo").textContent=`${formatDataDate(view.date)}${view.day?` ・ ${view.day}`:""}`;
  $("venueGrade").textContent=meetingGrade(m);
  $("eventTitle").textContent=m.title||"";

  $("quickDay").textContent=view.day||"開催日";
  $("quickNext").textContent=next?`${next.raceNo}R`:(view.date>state.dateJST?"未確定":"本日終了");
  $("quickDeadline").textContent=next?(next.deadline||"-"):"-";

  renderRaceJump(view);
  renderRaces(view);

  const autoTarget=next || (view.races||[]).slice(-1)[0] || null;
  if(autoTarget){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      jumpRace(Number(autoTarget.raceNo), "instant", "center");
    }));
  }
}

function renderRaceJump(m){
  const raceMap=new Map((m.races||[]).map(r=>[Number(r.raceNo),r]));
  $("raceJump").innerHTML=Array.from({length:12},(_,i)=>i+1).map(n=>{
    const r=raceMap.get(n);
    if(!r)return `<button disabled style="opacity:.42">${n}R</button>`;
    const cancelled=raceIsCancelled(r);
    return `<button class="${cancelled?"cancelledRaceJump":""}" onclick="jumpRace(${n})">${n}R${cancelled?'<small>中止</small>':""}</button>`;
  }).join("");
}
function jumpRace(no, behavior="smooth", block="start"){
  const el=document.getElementById(`race-card-${no}`);
  if(!el)return;
  document.querySelectorAll("#raceJump button").forEach((b,i)=>b.classList.toggle("active",i===Number(no)-1));
  el.scrollIntoView({behavior,block});
}

function raceMinutesUntil(deadline){
  if(!deadline)return null;
  const now=jstNow();
  const [h,m]=deadline.split(":").map(Number);
  const [nh,nm]=now.time.split(":").map(Number);
  return h*60+m-(nh*60+nm);
}
function raceStatusInfo(r,m){
  const cancel=raceCancelStatus(r);
  if(cancel==="postponed")return {label:"中止順延",cls:"cancelled"};
  if(cancel==="cancelled")return {label:"中止",cls:"cancelled"};
  if(m.date<jstNow().date)return {label:"締切済",cls:"closed"};
  if(m.date>jstNow().date)return {label:"受付予定",cls:"soon"};
  const mins=raceMinutesUntil(r.deadline);
  const now=jstNow();
  const past=!!r.deadline&&m.date===now.date&&raceIsPast(r.deadline,now.time);
  if(past)return {label:"締切済",cls:"closed"};
  if(mins!==null&&mins>=0&&mins<=10)return {label:`あと ${mins}分`,cls:"urgent"};
  return {label:r.deadline?"受付予定":"時刻未定",cls:"soon"};
}
async function openVenue(code, push=true){
  try{await ensureVenue(code);}
  catch(error){console.warn("Venue data unavailable",error);
    $("loadError").classList.remove("hidden");
    $("loadError").textContent="開催場データを取得できませんでした。通信状態を確認して、もう一度お試しください。";
    return;
  }
  const m=bcHomeMeetings().find(x=>x.venueCode===code);if(!m)return;
  if(push)history.pushState({view:"venue",code},"",`#venue-${code}`);
  state.currentMeeting=m;

  $("home").classList.add("hidden");
  $("detail").classList.add("hidden");
  $("venue").classList.remove("hidden");

  const days=normalizedMeetDays(m);
  const preferred=days.find(d=>d.date===m.date)?.date || m.date || days[0]?.date;
  state.currentDayDate=preferred;
  const view=currentDayView(m,preferred);
  state.currentMeetingView=view;

  const next=getNextRace(view);
  const grade=meetingGrade(m);

  $("venueName").textContent=m.venueName;
  $("venueInfo").textContent=`${formatDataDate(view.date)}${view.day?` ・ ${view.day}`:""}`;
  $("venueGrade").textContent=grade;
  $("eventTitle").textContent=m.title||"";

  $("quickDay").textContent=view.day||"開催日";
  const cancelStatus=meetingCancelStatus(view);
  $("quickNext").textContent=cancelStatus==="postponed"?"中止順延":cancelStatus==="cancelled"?"開催中止":next?`${next.raceNo}R`:(cancelStatus==="partial_cancelled"?"一部中止":"本日終了");
  $("quickDeadline").textContent=next?(next.deadline||"-"):"-";

  renderMeetDayTabs(m,preferred);
  updateVenueSelectedDayBanner(m,preferred);
  renderRaceJump(view);
  renderRaces(view);

  // 場詳細を開いた時点で、現在時刻から最も締切が近いRへ自動移動。
  // 全レース終了後は、その日の最後のRへ移動。
  const autoTarget=next || (view.races||[]).slice(-1)[0] || null;
  if(autoTarget){
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      jumpRace(Number(autoTarget.raceNo), "instant", "center");
    }));
  }else{
    scrollTo({top:0,behavior:"instant"});
  }
}
function cleanRacerName(name){
  return String(name||"")
    .replace(/^(?:投票|発売終了|発売中|投票受付中|受付終了)\s*/g,"")
    .replace(/\s*(?:投票|発売終了|発売中|投票受付中|受付終了)$/g,"")
    .trim();
}

function racerNameClass(name){
  const s=String(name||"").replace(/\s+/g,"");
  return Array.from(s).length>=5 ? "longRacerName" : "shortRacerName";
}

function renderRaces(m){
  const races=m.races||[];
  if(!races.length){
    $("races").innerHTML=`<div class="dayNoData"><b>${m.date>state.dateJST?"出走表はまだ未確定です":"レースデータを確認中です"}</b>${esc(formatDataDate(m.date))}のデータが公開され次第、自動で表示します。</div>`;
    return;
  }

  $("races").innerHTML=races.map(r=>{
    const info=raceStatusInfo(r,m);
    const urgent=info.cls==="urgent";
    const cancelled=info.cls==="cancelled";

    const boats=entryRacerTable(r.boats||[],false);

    return `<div class="raceCardPro ${cancelled?"raceCancelled":""}" id="race-card-${Number(r.raceNo)}" onclick="openRace(${Number(r.raceNo)})">
      <div class="raceTopPro">
        <div class="raceNoPro">${r.raceNo}<small>R</small></div>
        <div class="raceTiming ${cancelled?"cancelledTiming":""}">
          <small>${cancelled?"レース状況":"締切予定"}</small>
          <b class="${urgent?"urgent":""}">${cancelled?esc(info.label):esc(r.deadline||"-")}</b>
        </div>
        <div class="raceCountdownBox ${urgent?"urgent":""}">
          ${(()=>{
            if(m.date<jstNow().date)return "締切済";
            if(m.date>jstNow().date)return "翌日開催";
            const mins=raceMinutesUntil(r.deadline);
            if(mins===null)return "";
            if(mins<=0)return "締切済";
            return esc(countdownText(r.deadline));
          })()}
        </div>
      </div>

      <div class="entryListWrap">${boats}</div>

      <div class="raceQuickGrid raceQuickGrid9" onclick="event.stopPropagation()">
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'racer')">選手情報</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'course')">コース別情報</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'meet')">節間成績</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'motor')">モーター情報</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'before')">直前情報</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'odds')">オッズ</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'result')">結果</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'replay')">リプレイ</button>
        <button type="button" onclick="openRaceData(${Number(r.raceNo)},'demo')">デモ投票</button>
      </div>
    </div>`;
  }).join("");
}

function raceLabel(r){
  return r?.raceName || r?.title || r?.name || "レース";
}

function renderRaceContext(){
  const m=state.currentMeeting||state.currentMeetingView||{};
  const view=state.currentMeetingView||m;
  const r=state.currentRace||{};
  const selectedDate=state.currentDayDate||view.date||m.date||"";
  const raw=String(selectedDate||"");

  const y=raw.length>=8?raw.slice(0,4):"";
  const mo=raw.length>=8?Number(raw.slice(4,6)):"";
  const d=raw.length>=8?Number(raw.slice(6,8)):"";
  const dayObj=normalizedMeetDays(m).find(x=>String(x.date)===raw)||{};

  $("ctxDay").textContent=dayObj.label||dayObj.day||view.day||m.day||"開催日";
  $("ctxDate").textContent=(y&&mo&&d)?`${y}/${String(mo).padStart(2,"0")}/${String(d).padStart(2,"0")}`:"--/--";
  $("ctxVenue").textContent=m.venueName||"";
  $("ctxTitle").textContent=m.title||"";
  $("ctxGrade").textContent=meetingGrade(m);
  $("ctxRaceNo").textContent=r.raceNo?`${r.raceNo}R`:"--R";
  $("ctxRaceLabel").textContent=raceLabel(r);
  $("ctxDeadline").textContent=r.deadline||"--:--";
  const ctxMins=raceMinutesUntil(r.deadline);
  const ctxCountdown=$("ctxCountdown");
  if(ctxCountdown){
    if(ctxMins===null||ctxMins<=0){
      ctxCountdown.textContent=ctxMins!==null&&ctxMins<=0?"締切済":"";
      ctxCountdown.classList.remove("urgent");
    }else{
      ctxCountdown.textContent=countdownText(r.deadline);
      ctxCountdown.classList.toggle("urgent",ctxMins<=10);
    }
  }

  const days=normalizedMeetDays(m);
  $("ctxMeetDays").innerHTML=days.map(x=>{
    const s=String(x.date||"");
    const mm=s.length>=8?Number(s.slice(4,6)):"";
    const dd=s.length>=8?Number(s.slice(6,8)):"";
    const active=s===raw;
    return `<button class="${active?"active":""}" onclick="selectMeetDayFromDetail('${esc(s)}')">
      <span>${mm&&dd?`${mm}/${dd}`:"--/--"}</span>
      <b>${esc(x.label||x.day||"")}</b>
    </button>`;
  }).join("");

  const races=view.races||[];
  $("ctxRaceTabs").innerHTML=Array.from({length:12},(_,i)=>{
    const no=i+1;
    const exists=races.find(x=>Number(x.raceNo)===no);
    const active=Number(r.raceNo)===no;
    return `<button class="${active?"active":""} ${exists?"":"disabled"}" ${exists?`onclick="openRace(${no})"`:"disabled"}>${no}R</button>`;
  }).join("");
}

function selectMeetDayFromDetail(date){
  const m=state.currentMeeting||state.currentMeetingView;
  if(!m)return;
  state.currentDayDate=date;
  const view=currentDayView(m,date);
  state.currentMeetingView=view;
  const next=getNextRace(view) || (view.races||[])[0] || null;
  if(next){
    openRace(Number(next.raceNo));
  }else{
    renderRaceContext();
  }
}

function openRace(no, push=true){
  const m=state.currentMeeting;if(!m)return;
  const view=state.currentMeetingView||m;
  const selectedDate=state.currentDayDate||view.date||m.date||"";
  if(push)history.pushState({view:"detail",code:m.venueCode,date:selectedDate,raceNo:Number(no)},"",`#race-${m.venueCode}-${selectedDate}-${no}`);
  const sourceRace=(view.races||[]).find(x=>Number(x.raceNo)===Number(no)) || (m.races||[]).find(x=>Number(x.raceNo)===Number(no));
  if(!sourceRace)return;
  const r=hydrateRaceForDisplay(sourceRace);
  state.currentRace=r;
  renderRaceContext();
  $("venue").classList.add("hidden");$("detail").classList.remove("hidden");
showRaceData("racer", document.querySelector('#raceDataTabs [data-panel="racer"]'));
  scrollTo({top:0,behavior:"instant"});
}
function scrollRaceDataToView(){
  const nav=document.querySelector(".topRaceDataNav");
  const header=document.querySelector("header");
  if(!nav)return;
  const headerH=header ? header.getBoundingClientRect().height : 0;
  const y=window.scrollY + nav.getBoundingClientRect().top - headerH - 10;
  window.scrollTo({top:Math.max(0,y),behavior:"instant"});
}
function openRaceData(no, type){
  openRace(no);
  requestAnimationFrame(()=>{
    const btn=document.querySelector(`#raceDataTabs [data-panel="${type}"]`);
    showRaceData(type, btn);
    setTimeout(scrollRaceDataToView,90);
  });
}

let coursePeriod="m6";
let courseSubTab="rate";
let recent20SelectedLane=1;
let courseAssignments={1:1,2:2,3:3,4:4,5:5,6:6};
let pendingCourseAssignments={1:1,2:2,3:3,4:4,5:5,6:6};
let courseChangeSequence=[];
let meetSelectedLane=1;
let beforeSubTab="info";
let oddsSubTab="trifecta";
let oddsSortMode="normal";
let demoMainTab="bet";
let demoBetType="trifecta";
let demoMethod="normal";
let demoSelections={first:[],second:[],third:[]};
let demoBetList=[];
let demoDraftList=[];
let demoBetModalOpen=false;
let demoCartOpen=false;
let demoCompleteData=null;
function demoLoadCart(){
  try{
    const v=JSON.parse(localStorage.getItem("boatCheckDemoCart")||"[]");
    return Array.isArray(v)?v:[];
  }catch(e){ return []; }
}
let demoCart=demoLoadCart();

let demoStake=100;
let demoPoints=Number(localStorage.getItem("boatCheckDemoPoints")||10000);




function assignedCourseForLane(lane, usePending=false){
  const n=Number(lane)||1;
  const source=usePending ? pendingCourseAssignments : courseAssignments;
  return Number(source[n])||n;
}
function orderedBoatsByAssignedCourse(boats, usePending=false){
  return [...boats].sort((a,b)=>{
    const ac=assignedCourseForLane(a.lane||1,usePending);
    const bc=assignedCourseForLane(b.lane||1,usePending);
    return ac-bc;
  });
}
function cloneAssignments(src){
  return {
    1:Number(src[1])||1,2:Number(src[2])||2,3:Number(src[3])||3,
    4:Number(src[4])||4,5:Number(src[5])||5,6:Number(src[6])||6
  };
}
function openCourseChangeEditor(){
  pendingCourseAssignments=cloneAssignments(courseAssignments);
  courseChangeSequence=[];
}
function resetPendingCourseAssignments(){
  pendingCourseAssignments={1:1,2:2,3:3,4:4,5:5,6:6};
  courseChangeSequence=[];
  renderCurrentCourseSubTab();
}
function commitCourseAssignments(){
  if(courseChangeSequence.length!==6){
    return;
  }
  const committed={};
  courseChangeSequence.forEach((lane,index)=>{
    committed[lane]=index+1;
  });
  courseAssignments=cloneAssignments(committed);
  pendingCourseAssignments=cloneAssignments(committed);
  courseChangeSequence=[];
  renderCurrentCourseSubTab();
}
function toggleCourseSequenceLane(lane){
  lane=Number(lane);
  if(!lane)return;

  const existingIndex=courseChangeSequence.indexOf(lane);
  if(existingIndex>=0){
    courseChangeSequence=courseChangeSequence.slice(0,existingIndex);
  }else{
    if(courseChangeSequence.length>=6)return;
    courseChangeSequence.push(lane);
  }

  const next={};
  courseChangeSequence.forEach((selectedLane,index)=>{
    next[selectedLane]=index+1;
  });

  // Keep unselected lanes temporarily in their committed slots until all 6 are chosen.
  for(let l=1;l<=6;l++){
    if(!next[l]) next[l]=assignedCourseForLane(l,false);
  }
  pendingCourseAssignments=next;
  renderCurrentCourseSubTab();
}

function renderCurrentCourseSubTab(){
  const panel=document.getElementById("courseInnerPanel");
  if(!panel)return;
  if(courseSubTab==="rate") panel.innerHTML=renderCourseRate();
  else if(courseSubTab==="last20") panel.innerHTML=renderRecent20();
  else panel.innerHTML=renderCourseChange();
}


function meetHistoryForBoat(b){
  const sources=[
    b?.meetResults,
    b?.seriesResults,
    b?.currentMeetResults,
    b?.meet?.results,
    b?.series?.results,
    b?.meetHistory,
    b?.currentSeries
  ];
  for(const s of sources){
    if(Array.isArray(s)) return s;
  }
  return [];
}

function meetValue(obj, keys){
  for(const key of keys){
    const parts=key.split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}

function meetNum(v,digits=2){
  const n=Number(v);
  if(!Number.isFinite(n)) return "--";
  return n.toFixed(digits);
}
function meetPct(v,digits=1){
  const n=Number(v);
  if(!Number.isFinite(n)) return "--";
  return `${n.toFixed(digits)}%`;
}
function meetRank(v){
  if(v===undefined || v===null || v==="") return "--";
  const n=Number(v);
  return Number.isFinite(n) ? `${n}位` : esc(v);
}
function meetFinish(v){
  if(v===undefined || v===null || v==="") return "--";
  const s=String(v);
  const n=parseInt(s,10);
  if(Number.isFinite(n) && n>=1 && n<=6){
    const cls=n===1?"meetFinish1":n===2?"meetFinish2":"";
    return `<span class="${cls}">${n}着</span>`;
  }
  return esc(s);
}
function meetFinishLabel(v){
  if(v===undefined || v===null || v==="") return "--";
  const raw=String(v).trim();
  const compacted=raw.replace(/\s+/g,"").toUpperCase();

  const n=Number(compacted);
  if(Number.isFinite(n) && n>=1 && n<=6) return `${n}着`;

  if(compacted==="転" || compacted.includes("転覆")) return "(転)";
  if(compacted==="落" || compacted.includes("落水")) return "(落)";
  if(compacted==="F" || compacted.includes("フライング")) return "(F)";
  if(compacted==="L" || compacted.includes("出遅")) return "(L)";

  return esc(raw);
}
function meetFinishClass(v){
  const n=Number(v);
  if(n===1)return "first";
  if(n===2)return "second";

  const s=String(v??"").replace(/\s+/g,"").toUpperCase();
  if(s==="転" || s.includes("転覆"))return "special accident";
  if(s==="落" || s.includes("落水"))return "special accident";
  if(s==="F" || s.includes("フライング"))return "special falseStart";
  if(s==="L" || s.includes("出遅"))return "special late";
  return "";
}

function meetLaneChip(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<1||n>6) return "--";
  return `<span class="meetLane lane${n}">${n}</span>`;
}
function meetST(v){
  if(v===undefined || v===null || v==="") return "--";
  const n=Number(v);
  if(!Number.isFinite(n)) return esc(v);
  return n.toFixed(2).replace(/^0/,"");
}
function meetDayLabel(v){
  if(v===undefined || v===null || v==="") return "--";
  const s=String(v);
  if(/^\d+$/.test(s)) return `${s}日目`;
  return esc(s);
}

function meetSummaryMetric(b, metric){
  const aliases={
    pointRate:["meetStats.pointRate","seriesStats.pointRate","meet.pointRate","series.pointRate","pointRate"],
    pointRank:["meetStats.pointRank","seriesStats.pointRank","meet.pointRank","series.pointRank","pointRank"],
    points:["meetStats.points","seriesStats.points","meet.points","series.points","points"],
    avgST:["meetStats.avgST","seriesStats.avgST","meet.avgST","series.avgST","avgST"],
    stRank:["meetStats.stRank","seriesStats.stRank","meet.stRank","series.stRank","stRank"],
    exhibitionRank:["meetStats.exhibitionRank","seriesStats.exhibitionRank","meet.exhibitionRank","exhibitionRank"],
    exhibitionTime:["meetStats.exhibitionTime","seriesStats.exhibitionTime","meet.exhibitionTime","exhibitionTime"],
    winRate:["meetStats.winRate","seriesStats.winRate","meet.winRate","series.winRate"],
    twoRate:["meetStats.twoRate","seriesStats.twoRate","meet.twoRate","series.twoRate"],
    threeRate:["meetStats.threeRate","seriesStats.threeRate","meet.threeRate","series.threeRate"],
    avgCourse:["meetStats.avgCourse","seriesStats.avgCourse","meet.avgCourse","series.avgCourse","avgCourse"],
    accidentRate:["meetStats.accidentRate","seriesStats.accidentRate","meet.accidentRate","series.accidentRate","accidentRate"],
    penalty:["meetStats.penalty","meetStats.deduction","seriesStats.penalty","seriesStats.deduction","meet.penalty","meet.deduction","penalty","deduction"],
    penaltyDetail:["meetStats.penaltyDetail","meetStats.deductionDetail","seriesStats.penaltyDetail","seriesStats.deductionDetail","meet.penaltyDetail","meet.deductionDetail","penaltyDetail","deductionDetail"],
    preTime:["meetStats.preInspectionTime","meetStats.preTime","seriesStats.preInspectionTime","seriesStats.preTime","meet.preInspectionTime","preInspectionTime","preTime"],
    preRank:["meetStats.preInspectionRank","meetStats.preRank","seriesStats.preInspectionRank","seriesStats.preRank","meet.preInspectionRank","preInspectionRank","preRank"]
  };
  return firstStat(b,aliases[metric]||[metric]);
}

function meetSelector(boats){
  return `<div class="meetSelector">
    ${boats.map(b=>{
      const lane=Number(b.lane)||1;
      const active=lane===meetSelectedLane;
      return `<button type="button" class="meetRacerCard laneBg${lane} ${active?"active":""}"
        onclick="setMeetSelectedLane(${lane})">
        <span class="meetBoatNo lane${lane}">${lane}</span>
        <strong>${formatRacerNameTwoLines(cleanRacerName(b.racerName)||"--")}</strong>
        <span>${esc(b.racerId||b.registrationNo||"----")}</span>
        <span>${esc(b.class||"--")}</span>
        <span>${b.period?esc(b.period)+"期":"--期"}</span>
        <span>${esc(normalizeBranchLabel(b.branch||b.region))}</span>
        ${active?`<em>選択中</em>`:""}
      </button>`;
    }).join("")}
  </div>`;
}

function setMeetSelectedLane(lane){
  meetSelectedLane=Number(lane)||1;
  const panel=document.getElementById("meetResultsPanel");
  if(panel) panel.innerHTML=renderMeetResultsInner();
}

function meetRankClasses(values, mode="desc"){
  const nums=values.map(v=>{
    const n=Number(v);
    return Number.isFinite(n)?n:null;
  });
  const valid=[...new Set(nums.filter(v=>v!==null))].sort((a,b)=>mode==="asc"?a-b:b-a);
  return nums.map(v=>{
    if(v===null)return "";
    if(v===valid[0])return "meetBest1";
    if(valid.length>1 && v===valid[1])return "meetBest2";
    return "";
  });
}

function meetSectionTable(title, rows, boats){
  return `<div class="meetFullSection">
    <div class="meetFullBar">${title}</div>
    <div class="meetSimpleTable">
      ${rows.map(row=>{
        const vals=boats.map((b,i)=>row.value(b,i));
        const classes=row.rankMode?meetRankClasses(vals,row.rankMode):vals.map(()=> "");
        return `<div class="meetSimpleRow">
          <div class="meetSimpleLabel">${row.label}</div>
          ${vals.map((v,i)=>`<div class="meetSimpleCell ${classes[i]}">${row.format(v)}</div>`).join("")}
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function meetCourseBadge(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<1||n>6)return `<span class="meetCourseBadge empty">--</span>`;
  return `<span class="meetCourseBadge lane${n}">${n}</span>`;
}

function openMeetHistoryResult(day,raceNo){
  const m=state.currentMeeting||state.currentMeetingView;
  if(!m)return;
  const days=normalizedMeetDays(m);
  const targetDay=days[Math.max(0,Number(day||1)-1)]||null;
  if(!targetDay)return;

  state.currentDayDate=targetDay.date;
  state.currentMeetingView=currentDayView(m,targetDay.date);
  const race=(state.currentMeetingView.races||[]).find(x=>Number(x.raceNo)===Number(raceNo));
  if(!race){
    demoToast("このレース結果はまだ取得されていません");
    return;
  }

  state.currentRace=race;
  history.pushState({view:"detail",code:m.venueCode,date:targetDay.date,raceNo:Number(raceNo)},"",`#race-${m.venueCode}-${targetDay.date}-${raceNo}`);
  renderRaceContext();
  $("venue").classList.add("hidden");
  $("detail").classList.remove("hidden");
  const btn=document.querySelector('#raceDataTabs [data-panel="result"]');
  showRaceData("result",btn);

  // 結果タブを開いた直後、ユーザーが見たい「結果」見出し位置へ自動移動。
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const target=document.querySelector("#quickDataPanel .resultInfoPage");
    const sticky=document.querySelector("header");
    if(!target)return;
    const offset=(sticky?.getBoundingClientRect().height||82)+8;
    const y=window.scrollY+target.getBoundingClientRect().top-offset;
    window.scrollTo({top:Math.max(0,y),behavior:"auto"});
  }));
}

function meetRaceCell(item){
  if(!item){
    return `<div class="meetPerfCell isEmpty">
      <div class="meetPerfCourse">${meetCourseBadge(null)}</div>
      <div class="meetPerfST"><span>ST</span><b>--</b></div>
      <div class="meetPerfFinish"><b>--</b></div>
    </div>`;
  }

  const st=meetValue(item,["st","startTiming","start"]);
  const course=meetValue(item,["course","entry","courseNo","actualCourse"]);
  const finish=meetValue(item,["finish","rank","arrival","finishPlace"]);
  const day=Number(meetValue(item,["day","meetDay","eventDay","dayNo"]));
  const raceNo=Number(meetValue(item,["raceNo","race","r"]));
  const finishNo=Number(finish);

  const canOpen=
    Number.isFinite(day)&&day>0&&
    Number.isFinite(raceNo)&&raceNo>0&&
    finish!==null&&finish!==undefined&&finish!=="";

  const cellClass=finishNo===1?" finish1":finishNo===2?" finish2":"";
  const finishClass=meetFinishClass(finish);

  return `<div class="meetPerfCell${cellClass}">
    <div class="meetPerfCourse">${meetCourseBadge(course)}</div>

    <div class="meetPerfST">
      <span>ST</span>
      <b>${meetST(st)}</b>
    </div>

    ${canOpen?`
      <button class="meetPerfFinish isLink ${finishClass}"
        onclick="openMeetHistoryResult(${day},${raceNo})"
        title="レース結果を見る">
        <b>${meetFinishLabel(finish)}</b>
        <i>›</i>
      </button>
    `:`
      <div class="meetPerfFinish ${finishClass}">
        <b>${meetFinishLabel(finish)}</b>
      </div>
    `}
  </div>`;
}

function renderMeetResultsInner(){
  const r=state.currentRace||{};
  const boats=hydrateBoatsForDisplay(r.boats||[]).slice(0,6);
  if(!boats.length) return `<p class="dataPlaceholder">出走選手データを取得中です。</p>`;

  const histories=boats.map(b=>meetHistoryForBoat(b));

  // 開催日程は会場データの全日程を基準に表示。
  // 成績が未取得の未来日も「--」で枠だけ表示する。
  const meeting=state.currentMeeting||state.currentMeetingView||{};
  const scheduleDays=normalizedMeetDays(meeting);
  let totalDays=scheduleDays.length;

  if(!totalDays){
    let detected=0;
    histories.flat().forEach(x=>{
      const d=Number(meetValue(x,["day","meetDay","eventDay","dayNo"]));
      if(Number.isFinite(d))detected=Math.max(detected,d);
    });
    const currentDay=Number(r.dayNo||r.day||r.meetDay||0);
    if(Number.isFinite(currentDay))detected=Math.max(detected,currentDay);
    totalDays=detected||1;
  }

  const raceFor=(boatIndex,day,slot)=>{
    const list=histories[boatIndex]||[];
    const dayItems=list.filter(x=>Number(meetValue(x,["day","meetDay","eventDay","dayNo"]))===day);
    dayItems.sort((a,b)=>{
      const ar=Number(meetValue(a,["race","raceNo","r"]))||99;
      const br=Number(meetValue(b,["race","raceNo","r"]))||99;
      return ar-br;
    });
    return dayItems[slot]||null;
  };

  const dayDateLabel=(day)=>{
    const item=scheduleDays[day-1];
    const s=String(item?.date||"");
    if(s.length>=8){
      return `${Number(s.slice(4,6))}/${Number(s.slice(6,8))}`;
    }
    return "";
  };

  const racerHeader=proRacerStrip(boats,"出走表");

  const dayRows=Array.from({length:totalDays},(_,di)=>{
    const day=di+1;
    const dateLabel=dayDateLabel(day);
    return [0,1].map(slot=>`<tr>
      ${slot===0?`<th class="meetDayCell" rowspan="2"><b>${day}日目</b>${dateLabel?`<span>${dateLabel}</span>`:""}</th>`:""}
      <th class="meetRunNo">${slot+1}走</th>
      ${boats.map((b,bi)=>`<td>${meetRaceCell(raceFor(bi,day,slot))}</td>`).join("")}
    </tr>`).join("");
  }).join("");

  const fmtNum=v=>v===undefined||v===null||v===""?"--":meetNum(v,2);
  const fmtPct=v=>v===undefined||v===null||v===""?"--":meetPct(v,1);
  const fmtRank=v=>v===undefined||v===null||v===""?"--":meetRank(v);
  const fmtRaw=v=>v===undefined||v===null||v===""?"--":esc(v);
  const fmtST=v=>v===undefined||v===null||v===""?"--":meetST(v);

  const pointRows=[
    {label:"順位", rankMode:"asc", value:b=>meetSummaryMetric(b,"pointRank"), format:fmtRank},
    {label:"得点率", rankMode:"desc", value:b=>meetSummaryMetric(b,"pointRate"), format:fmtNum},
    {label:"減点", value:b=>meetSummaryMetric(b,"penalty"), format:fmtRaw},
    {label:"減点詳細", value:b=>meetSummaryMetric(b,"penaltyDetail"), format:fmtRaw}
  ];

  const startRows=[
    {label:"平均ST", rankMode:"asc", value:b=>meetSummaryMetric(b,"avgST"), format:fmtST},
    {label:"ST順位", rankMode:"asc", value:b=>meetSummaryMetric(b,"stRank"), format:fmtRank}
  ];

  const displayRows=[
    {label:"展示順位", rankMode:"asc", value:b=>meetSummaryMetric(b,"exhibitionRank"), format:fmtRank},
    {label:"平均展示タイム", rankMode:"asc", value:b=>meetSummaryMetric(b,"exhibitionTime"), format:fmtNum}
  ];

  const winRows=[
    {label:"1着率", rankMode:"desc", value:b=>meetSummaryMetric(b,"winRate"), format:fmtPct},
    {label:"2連率", rankMode:"desc", value:b=>meetSummaryMetric(b,"twoRate"), format:fmtPct},
    {label:"3連率", rankMode:"desc", value:b=>meetSummaryMetric(b,"threeRate"), format:fmtPct}
  ];

  const preRows=[
    {label:"前検タイム", rankMode:"asc", value:b=>meetSummaryMetric(b,"preTime"), format:fmtNum},
    {label:"前検順位", rankMode:"asc", value:b=>meetSummaryMetric(b,"preRank"), format:fmtRank}
  ];

  return `
    <div class="meetPageTitle">
      <div><h3>節間成績</h3><p>6艇の今節データを横並びで比較</p></div>
      <span>未取得は --</span>
    </div>

    <div class="meetConnectedFrame meetProConnected">
      ${racerHeader}
      <div class="meetFullSection first">
        <div class="meetFullBar meetResultsBar"><span>節間成績</span><small>上から 進入 → ST → 着順　　着順タップで結果</small></div>
        <div class="meetRunsTable">
          <table class="meetRunsGrid">
            <colgroup>
              <col class="dayCol">
              <col class="runCol">
              <col><col><col><col><col><col>
            </colgroup>
            <thead>
              <tr>
                <th>日程</th><th>走</th>
                ${boats.map(b=>`<th class="laneHead laneHead${b.lane}">${b.lane}</th>`).join("")}
              </tr>
            </thead>
            <tbody>${dayRows}</tbody>
          </table>
        </div>
      </div>

      ${meetSectionTable("得点率",pointRows,boats)}
      ${meetSectionTable("スタート",startRows,boats)}
      ${meetSectionTable("展示",displayRows,boats)}
      ${meetSectionTable("勝率",winRows,boats)}
      ${meetSectionTable("前検",preRows,boats)}
    </div>

    <div class="meetLegend">
      <span><i class="one"></i>1位（最も優れた値）</span>
      <span><i class="two"></i>2位（2番目に優れた値）</span>
    </div>
    <div class="meetDataNote">※ 公開情報を取得できた項目を反映します。未取得項目は「--」表示。</div>
  `;
}

function renderMeetResults(){
  return `<div class="dataSection meetResults" id="meetResultsPanel">${renderMeetResultsInner()}</div>`;
}

function courseFirstStat(b, keys){
  for(const k of keys){
    const parts=k.split(".");
    let v=b;
    for(const p of parts){
      if(v===undefined||v===null)break;
      v=v[p];
    }
    if(v!==undefined&&v!==null&&v!=="")return v;
  }
  return null;
}

function courseOfficialMetric(b, courseNo, metric){
  const aliases={
    entryRate:[
      `courseStatsOfficial.${courseNo}.entryRate`,
      `courseStats.${courseNo}.official.entryRate`
    ],
    threeRate:[
      `courseStatsOfficial.${courseNo}.threeRate`,
      `courseStats.${courseNo}.official.threeRate`
    ],
    avgST:[
      `courseStatsOfficial.${courseNo}.avgST`,
      `courseStats.${courseNo}.official.avgST`
    ],
    avgStartRank:[
      `courseStatsOfficial.${courseNo}.avgStartRank`,
      `courseStats.${courseNo}.official.avgStartRank`
    ]
  };
  return courseFirstStat(b,aliases[metric]||[]);
}

function officialCourseStatsAvailable(boats){
  return (boats||[]).some((b,i)=>{
    const c=assignedCourseForLane(b.lane||i+1);
    return ["entryRate","threeRate","avgST","avgStartRank"]
      .some(k=>courseOfficialMetric(b,c,k)!==null);
  });
}

function renderOfficialCourseStatsBlock(boats){
  const hasData=officialCourseStatsAvailable(boats);
  const vals=(metric)=>boats.map((b,i)=>{
    const c=assignedCourseForLane(b.lane||i+1);
    return courseOfficialMetric(b,c,metric);
  });
  const courseCellsText=boats.map((b,i)=>{
    const c=assignedCourseForLane(b.lane||i+1);
    return `<td><span class="officialCourseNo">${c}コース</span></td>`;
  }).join("");
  const rows=[
    `<tr><th>参照コース</th>${courseCellsText}</tr>`,
    `<tr><th>進入率</th>${courseCells(vals("entryRate"),"desc","%",1)}</tr>`,
    `<tr><th>3連対率</th>${courseCells(vals("threeRate"),"desc","%",1)}</tr>`,
    `<tr><th>平均ST</th>${courseCells(vals("avgST"),"asc","",2)}</tr>`,
    `<tr><th>平均スタート順</th>${courseCells(vals("avgStartRank"),"asc","位",1)}</tr>`
  ].join("");
  const checked=boats.map(b=>b.courseStatsCheckedAt).filter(Boolean).sort().slice(-1)[0];
  let checkedText="";
  if(checked){
    try{
      const d=new Date(checked);
      checkedText=`最終取得 ${new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}`;
    }catch(e){}
  }
  return `<div class="courseDataBlock officialCourseBlock ${hasData?"":"isEmpty"}">
    ${courseBar("公開情報によるコース別成績",checkedText||"公開成績")}
    <div class="officialCourseLead">各選手の現在の想定進入コースに対応した公式成績です。進入コース変更をすると参照コースも連動します。</div>
    ${courseSimpleTable(rows,"officialCourseTable")}
    <div class="courseDataNote">※ 公式選手ページの集計期間をそのまま使用。未取得項目は「--」表示。</div>
  </div>`;
}

function courseAggregatedBoat(b){
  const id=String(b?.racerId||b?.registrationNo||"");
  const aggregate=state.courseStatsByRacer?.[id];
  if(!aggregate)return b;
  return {...b,courseStats:Object.fromEntries([1,2,3,4,5,6].map(c=>[c,{...b.courseStats?.[c],...aggregate[c]}]))};
}
function courseMetric(b, courseNo, metric, period=coursePeriod){
  b=courseAggregatedBoat(b);
  const sample=b.courseStats?.[courseNo]?.[period];
  if(sample?.entryCount===0 && metric!=="entryCount" && metric!=="frameWin") return "対象なし";
  if(sample && metric==="frameWin" && sample.frameWinRate==null)return "対象なし";
  const optional={st:"avgST",stRank:"stRank",displayRank:"displayRank"};
  if(sample?.entryCount>0 && optional[metric] && sample[optional[metric]]==null)return "記録なし";
  const aliases={
    win:[
      `courseStats.${courseNo}.${period}.winRate`,
      `courseStats.${period}.${courseNo}.winRate`,
      `courses.${courseNo}.${period}.winRate`,
      `course.${courseNo}.${period}.winRate`
    ],
    two:[
      `courseStats.${courseNo}.${period}.twoRate`,
      `courseStats.${courseNo}.${period}.quinellaRate`,
      `courseStats.${period}.${courseNo}.twoRate`,
      `courses.${courseNo}.${period}.twoRate`
    ],
    three:[
      `courseStats.${courseNo}.${period}.threeRate`,
      `courseStats.${courseNo}.${period}.trifectaRate`,
      `courseStats.${period}.${courseNo}.threeRate`,
      `courses.${courseNo}.${period}.threeRate`
    ],
    frameWin:[
      `courseStats.${courseNo}.${period}.frameWinRate`,
      `courseStats.${period}.${courseNo}.frameWinRate`,
      `courses.${courseNo}.${period}.frameWinRate`,
      `frameStats.${courseNo}.${period}.winRate`
    ],
    st:[
      `courseStats.${courseNo}.${period}.avgST`,
      `courseStats.${period}.${courseNo}.avgST`,
      `courses.${courseNo}.${period}.avgST`
    ],
    stRank:[
      `courseStats.${courseNo}.${period}.stRank`,
      `courseStats.${period}.${courseNo}.stRank`,
      `courses.${courseNo}.${period}.stRank`
    ],
    displayRank:[
      `courseStats.${courseNo}.${period}.displayRank`,
      `courseStats.${period}.${courseNo}.displayRank`,
      `courses.${courseNo}.${period}.displayRank`
    ],
    escape:[
      `courseStats.${courseNo}.${period}.kimarite.escape`,
      `courseStats.${courseNo}.${period}.escapeRate`,
      `courses.${courseNo}.${period}.escapeRate`
    ],
    passed:[
      `courseStats.${courseNo}.${period}.kimarite.passed`,
      `courseStats.${courseNo}.${period}.passedRate`,
      `courses.${courseNo}.${period}.passedRate`
    ],
    makurare:[
      `courseStats.${courseNo}.${period}.kimarite.makurare`,
      `courseStats.${courseNo}.${period}.makurareRate`,
      `courses.${courseNo}.${period}.makurareRate`
    ],
    makurareSashi:[
      `courseStats.${courseNo}.${period}.kimarite.makurareSashi`,
      `courseStats.${courseNo}.${period}.makurareSashiRate`,
      `courses.${courseNo}.${period}.makurareSashiRate`
    ],
    sashi:[
      `courseStats.${courseNo}.${period}.kimarite.sashi`,
      `courseStats.${courseNo}.${period}.sashiRate`,
      `courses.${courseNo}.${period}.sashiRate`
    ],
    makuri:[
      `courseStats.${courseNo}.${period}.kimarite.makuri`,
      `courseStats.${courseNo}.${period}.makuriRate`,
      `courses.${courseNo}.${period}.makuriRate`
    ],
    makuriSashi:[
      `courseStats.${courseNo}.${period}.kimarite.makuriSashi`,
      `courseStats.${courseNo}.${period}.makuriSashiRate`,
      `courses.${courseNo}.${period}.makuriSashiRate`
    ],
    nigashi:[
      `courseStats.${courseNo}.${period}.kimarite.nigashi`,
      `courseStats.${courseNo}.${period}.nigashiRate`,
      `courses.${courseNo}.${period}.nigashiRate`
    ],
    nuki:[
      `courseStats.${courseNo}.${period}.kimarite.nuki`,
      `courseStats.${courseNo}.${period}.nukiRate`,
      `courses.${courseNo}.${period}.nukiRate`
    ],
    entryCount:[
      `courseStats.${courseNo}.${period}.entryCount`,
      `courseStats.${courseNo}.${period}.entries`,
      `courseStats.${courseNo}.${period}.startCount`,
      `courseStats.${courseNo}.${period}.raceCount`,
      `courseStats.${courseNo}.${period}.sampleCount`,
      `courses.${courseNo}.${period}.entryCount`,
      `courses.${courseNo}.${period}.entries`
    ]
  };
  return courseFirstStat(b, aliases[metric]||[]);
}

function courseMetricCount(b, courseNo, key, period=coursePeriod){
  b=courseAggregatedBoat(b);
  const aliases = [
    `courseStats.${courseNo}.${period}.kimarite.${key}Count`,
    `courseStats.${courseNo}.${period}.kimarite.${key}.count`,
    `courseStats.${courseNo}.${period}.${key}Count`,
    `courseStats.${courseNo}.${period}.kimariteCounts.${key}`,
    `courses.${courseNo}.${period}.kimarite.${key}Count`,
    `courses.${courseNo}.${period}.kimariteCounts.${key}`
  ];
  return courseFirstStat(b, aliases);
}

function courseCountText(v){
  if(v===undefined || v===null || v==="") return "--";
  const s = String(v).trim();
  if(!s || s==="--") return "--";
  const n = Number(s);
  if(Number.isFinite(n)) return String(Math.round(n));
  return s;
}

function courseCountDisplay(b, courseNo, key, period=coursePeriod){
  if(courseMetric(b,courseNo,"entryCount",period)===0)return "対象なし";
  const count = courseMetricCount(b, courseNo, key, period);
  const total = courseMetric(b, courseNo, "entryCount", period);
  if((count===undefined || count===null || count==="") && (total===undefined || total===null || total==="")){
    return "--";
  }
  return `${courseCountText(count)}/${courseCountText(total)}`;
}

function courseFmt(v, suffix="", digits=null){
  if(v===undefined||v===null||v==="")return "--";
  let s=String(v).trim();
  if(!s||s==="--")return "--";
  const raw=s.replace(/[％%]/g,"").replace(/,/g,"");
  if(digits!==null && /^-?\d+(?:\.\d+)?$/.test(raw)){
    s=Number(raw).toFixed(digits);
  }
  if(s==="対象なし"||s==="記録なし")return s;
  if(suffix && !s.endsWith(suffix))s+=suffix;
  return esc(s);
}

function courseRankInfo(values, mode="desc"){
  const nums=values
    .map((v,i)=>({i,n:parseRankableNumber(v)}))
    .filter(x=>x.n!==null);
  nums.sort((a,b)=>mode==="asc"?a.n-b.n:b.n-a.n);
  const first=nums[0]?.i;
  let second=null;
  for(const x of nums){
    if(x.i!==first){second=x.i;break;}
  }
  return {first,second};
}

function courseCells(values, mode="desc", suffix="", digits=null, highlight=true){
  const rank=highlight?courseRankInfo(values,mode):{first:null,second:null};
  return values.map((v,i)=>{
    const cls=i===rank.first?"courseBest1":i===rank.second?"courseBest2":"";
    return `<td class="${cls}">${courseFmt(v,suffix,digits)}</td>`;
  }).join("");
}



function uiRacerKey(v){
  return String(v||"")
    .replace(/^(?:投票|発売終了|発売中|投票受付中|受付終了)\s*/,"")
    .replace(/[　\s]+/g,"")
    .trim();
}
function uiMeetingRacerRegistry(){
  const m=state.currentMeeting||state.currentMeetingView;
  const byId=new Map();
  const byName=new Map();
  if(!m)return {byId,byName};

  const races=[...(m.races||[])];
  (m.meetDays||[]).forEach(d=>(d.races||[]).forEach(r=>races.push(r)));

  const score=b=>[
    b?.racerId,b?.registrationNo,b?.branch,b?.origin,b?.period,b?.age,
    b?.flyingCount,b?.lateCount,b?.avgST,b?.stats,b?.meetResults,b?.meetStats
  ].filter(v=>v!==undefined&&v!==null&&v!==""&&!(Array.isArray(v)&&!v.length)).length;

  races.forEach(r=>(r.boats||[]).forEach(b=>{
    const id=String(b.racerId||b.registrationNo||"");
    const name=uiRacerKey(b.racerName);
    const s=score(b);
    if(id && (!byId.has(id)||s>byId.get(id).score))byId.set(id,{score:s,b});
    if(name && (!byName.has(name)||s>byName.get(name).score))byName.set(name,{score:s,b});
  }));
  return {byId,byName};
}
function hydrateBoatsForDisplay(boats){
  const reg=uiMeetingRacerRegistry();
  const keys=[
    "racerId","registrationNo","class","branch","origin","period","age",
    "flyingCount","lateCount","avgST",
    "nationalWinRate","national2Rate","national3Rate",
    "localWinRate","local2Rate","local3Rate",
    "stats","courseStats","courseStatsOfficial","courseStatsSource","courseStatsCheckedAt",
    "meetResults","meetStats"
  ];
  return (boats||[]).map(b=>{
    const id=String(b.racerId||b.registrationNo||"");
    const name=uiRacerKey(b.racerName);
    const out={...b};
    const src=(id&&reg.byId.get(id)?.b)||(!id&&reg.byName.get(name)?.b);
    if(src)keys.forEach(k=>{
      const v=out[k];
      const empty=v===undefined||v===null||v===""||(Array.isArray(v)&&!v.length);
      if(empty && src[k]!==undefined && src[k]!==null && src[k]!=="")out[k]=src[k];
    });
    if(id && !out.period)out.period=state.racerDirectory?.[id]?.period||state.entryDetails?.byRacer?.[id]?.period||null;
    return out;
  });
}
function hydrateRaceForDisplay(race){
  if(!race)return race;
  return {...race,boats:hydrateBoatsForDisplay(race.boats||[])};
}

function entryFLCount(boat, key){
  const raw=boat[key] ?? boat.stats?.[key];
  if(raw===null || raw===undefined || raw==="")return "--";
  const value=String(raw).replace(/^[FL]/i,"");
  return /^\d+$/.test(value)?esc(value):"--";
}
function entryRacerTable(boats, withLabels=true){
  boats=hydrateBoatsForDisplay(boats).slice(0,6);
  const rows=[
    ["登録番号",b=>esc(b.racerId||b.registrationNo||"----"),"registration"],
    ["枠番・名前",b=>`<span class="entryLane lane${Number(b.lane)}">${Number(b.lane)}</span><button type="button" class="bcRacerLink" data-racer-id="${esc(b.racerId||b.registrationNo||'')}" data-racer-name="${esc(cleanRacerName(b.racerName))}" onclick="event.stopPropagation();bcOpenRacer(this)"><strong>${formatRacerNameTwoLines(cleanRacerName(b.racerName)||"--")}</strong></button>`,"identity"],
    ["級",b=>esc(b.class||"--"),"class"],
    ["期",b=>b.period?`${esc(b.period)}期`:"--", "period"],
    ["支部",b=>esc(normalizeBranchLabel(b.branch||b.region)),"branch"],
    ["F｜L",b=>`<span>F${entryFLCount(b,"flyingCount")}</span><i aria-hidden="true">|</i><span>L${entryFLCount(b,"lateCount")}</span>`,"fl"]
  ];
  return `<div class="entryRacerTable ${withLabels?'entryWithLabels':'entryWithoutLabels'}" role="table" aria-label="出走表">${rows.map(([label,render,type])=>`<div class="entryGridRow entryRow-${type}" role="row">${withLabels?`<div class="entryRowLabel" role="rowheader">${label}</div>`:''}${boats.map(b=>`<div class="entryGridCell proLaneBg${Number(b.lane)}" role="cell">${render(b)}</div>`).join("")}</div>`).join("")}</div>`;
}
function proRacerStrip(boats, label="出走表"){
  return entryRacerTable(boats,true);
}

function coursePlayerHeader(boats){
  return proRacerStrip(boats,"出走表");
}

function courseBar(title, periodText){
  return `<div class="courseStatBar">
    <b>${title}</b>
    <span>${periodText||""}</span>
  </div>`;
}

function courseSimpleTable(rows, extraClass=""){
  return `<table class="courseStatTable ${extraClass}"><tbody>${rows}</tbody></table>`;
}

function renderKimariteLayout(boats, periodText){
  const course1Boat = boats.find(b=>assignedCourseForLane(b.lane||1)===1) || boats[0];
  const outerBoats = [2,3,4,5,6].map(courseNo=>
    boats.find(b=>assignedCourseForLane(b.lane||1)===courseNo)
  ).filter(Boolean);

  const oneCourse=course1Boat ? assignedCourseForLane(course1Boat.lane||1) : 1;
  const oneVals = {
    escape: course1Boat ? courseMetric(course1Boat,oneCourse,"escape") : null,
    passed: course1Boat ? courseMetric(course1Boat,oneCourse,"passed") : null,
    makurare: course1Boat ? courseMetric(course1Boat,oneCourse,"makurare") : null,
    makurareSashi: course1Boat ? courseMetric(course1Boat,oneCourse,"makurareSashi") : null
  };

  const attackRows = [
    {label:"逃し率", metric:"nigashi", limited:[2,3]},
    {label:"差し率", metric:"sashi"},
    {label:"捲り率", metric:"makuri"},
    {label:"捲り差し率", metric:"makuriSashi"}
  ];

  const attackTable = attackRows.map(row=>{
    const vals = outerBoats.map(boat=>{
      const laneNo=Number(boat.lane)||1;
      const assigned=assignedCourseForLane(laneNo);
      const raw=courseMetric(boat,assigned,row.metric);
      const isActive=!row.limited || row.limited.includes(assigned);
      return `<td class="${isActive?"":"mutedCell"}">${isActive?courseFmt(raw,"%",1):"対象外"}</td>`;
    }).join("");
    return `<tr><th>${row.label}</th>${vals}</tr>`;
  }).join("");

  return `<div class="kimariteUnified">
    ${courseBar("決まり手別割合",periodText)}

    <div class="kimariteHead">
      <div class="kimariteHeadOne">1コースの守備的決まり手</div>
      <div class="kimariteHeadAttack">2〜6コースの攻撃的決まり手</div>
    </div>

    <div class="kimariteSplit">
      <div class="kimariteOne">
        <table>
          <colgroup><col class="eqCol"><col class="eqCol"></colgroup>
          <thead>
            <tr>
              <th>&nbsp;</th>
              <th class="laneHead laneHead${course1Boat?.lane||1}">${course1Boat?.lane||1}</th>
            </tr>
          </thead>
          <tbody>
            <tr><th>逃げ率</th><td>${courseFmt(oneVals.escape,"%",1)}</td></tr>
            <tr><th>差され率</th><td>${courseFmt(oneVals.passed,"%",1)}</td></tr>
            <tr><th>捲られ率</th><td>${courseFmt(oneVals.makurare,"%",1)}</td></tr>
            <tr><th>捲られ差し率</th><td>${courseFmt(oneVals.makurareSashi,"%",1)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="kimariteAttack">
        <table>
          <colgroup>
            <col class="eqCol"><col class="eqCol"><col class="eqCol">
            <col class="eqCol"><col class="eqCol"><col class="eqCol">
          </colgroup>
          <thead>
            <tr>
              <th>&nbsp;</th>
              ${outerBoats.map(b=>`<th class="laneHead laneHead${b.lane}">${b.lane}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${attackTable}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function renderCourseRate(){
  const r=state.currentRace||{};
  const sourceBoats=(r.boats||[]).slice(0,6);
  const boats=orderedBoatsByAssignedCourse(sourceBoats,false);
  if(!boats.length){
    return `<div class="dataSection"><p class="dataPlaceholder">出走選手データを取得中です。</p></div>`;
  }

  const periodLabels={m1:"直近1ヶ月",m3:"直近3ヶ月",m6:"直近6ヶ月",y1:"直近1年"};
  const periodText=periodLabels[coursePeriod];

  const row=(label,metric,mode="desc",suffix="",digits=null)=>{
    const vals=boats.map((b,i)=>courseMetric(b,assignedCourseForLane(b.lane||i+1),metric));
    return `<tr><th>${label}</th>${courseCells(vals,mode,suffix,digits)}</tr>`;
  };

  const winRows=[
    row("出走数","entryCount","desc","走",0),
    row("1着率","win","desc","%",1),
    row("2連対率","two","desc","%",1),
    row("3連対率","three","desc","%",1)
  ].join("");

  const frameRows=row("枠別1着率","frameWin","desc","%",1);

  const stRows=[
    row("平均ST","st","asc","",2),
    row("ST順位","stRank","asc","",1)
  ].join("");

  const kimariteSummaryRows=[
    ["逃げ","escape"],
    ["差し","sashi"],
    ["捲り差し","makuriSashi"],
    ["捲り","makuri"],
    ["抜き","nuki"]
  ].map(([label,key])=>{
    const vals=boats.map((b,i)=>courseCountDisplay(b,assignedCourseForLane(b.lane||i+1),key));
    return `<tr><th>${label}</th>${vals.map(v=>`<td>${esc(v)}</td>`).join("")}</tr>`;
  }).join("");

  const displayRows=row("平均展示順位","displayRank","asc","",1);

  return `<div class="courseRatePanel courseUnifiedPanel">
    <div class="coursePeriodTabs">
      ${[
        ["m1","1ヶ月"],["m3","3ヶ月"],["m6","6ヶ月"],["y1","1年"]
      ].map(([k,l])=>`<button class="${coursePeriod===k?"active":""}" onclick="setCoursePeriod('${k}')">${l}</button>`).join("")}
    </div>

    <div class="courseUnifiedSheet">
      ${coursePlayerHeader(boats)}

      ${renderOfficialCourseStatsBlock(boats)}

      <div class="courseDataBlock">
        ${courseBar("勝率",periodText)}
        ${courseSimpleTable(winRows)}
      </div>

      <div class="courseDataBlock">
        ${courseBar("枠別1着率",periodText)}
        ${courseSimpleTable(frameRows)}
      </div>

      <div class="courseDataBlock">
        ${courseBar("スタート",periodText)}
        ${courseSimpleTable(stRows)}
      </div>

      <div class="courseDataBlock">
        ${courseBar("決まり手",periodText)}
        ${courseSimpleTable(kimariteSummaryRows)}
      </div>

      ${renderKimariteLayout(boats,periodText)}

      <div class="courseDataBlock">
        ${courseBar("平均展示順位",periodText)}
        ${courseSimpleTable(displayRows)}
      </div>
    </div>

    <div class="courseDataNote">
      ${state.courseStatsMeta?`集計基準：${esc(state.courseStatsMeta.to)}まで。期間別に公式結果を独自集計。${state.courseStatsMeta.errors?.length?`未取得日が${state.courseStatsMeta.errors.length}日あり、取得済み分の集計です。`:""}`:"期間別データを読み込み中です。"}<br>
      1着率・連対率・決まり手割合は該当コースの出走数が分母。枠別1着率は枠番で集計。STはF・Lを除外し、同値は同順位。逃し率は1コースが逃げた割合。対象なし＝期間内出走なし。
    </div>
  </div>`;
}


function recent20HistoryForBoat(b){
  const racerId=String(b?.racerId||b?.registrationNo||"");
  const sources=[b?.recent20,b?.recent20Races,b?.last20,b?.history20,b?.recentRaces,b?.stats?.recent20,b?.stats?.recent20Races,b?.history?.recent20];
  for(const s of sources){if(Array.isArray(s))return s;}
  const idCandidates=[racerId,racerId.replace(/^0+/,""),racerId.padStart(4,"0")].filter(Boolean);
  for(const id of idCandidates){
    const shared=state.recent20ByRacer?.[id];
    if(Array.isArray(shared))return shared;
  }
  return [];
}
function recent20Value(row,keys){
  for(const k of keys){let v=row;for(const p of k.split('.')){if(v===undefined||v===null)break;v=v[p];}if(v!==undefined&&v!==null&&v!=="")return v;}
  return null;
}
function recent20Date(v){
  if(v===undefined||v===null||v==="")return "--";
  const s=String(v).trim();
  const m=s.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})$/);
  if(m)return `<strong>${Number(m[2])}/${Number(m[3])}</strong><small>${m[1]}</small>`;
  return esc(s);
}
function recent20Grade(v){
  if(v===undefined||v===null||v==="")return `<span class="r20Grade general">一般</span>`;
  const s=String(v).toUpperCase();let cls="general",label=String(v);
  if(s.includes("SG")){cls="sg";label="SG";} else if(s.includes("G1")||s.includes("GⅠ")){cls="g1";label="G1";} else if(s.includes("G2")||s.includes("GⅡ")){cls="g2";label="G2";} else if(s.includes("G3")||s.includes("GⅢ")){cls="g3";label="G3";} else if(s.includes("一般")){cls="general";label="一般";}
  return `<span class="r20Grade ${cls}">${esc(label)}</span>`;
}
function recent20LaneChip(v){const n=Number(v);if(!Number.isFinite(n)||n<1||n>6)return "--";return `<span class="r20Lane lane${n}">${n}</span>`;}
function recent20Result(v){
  if(v===undefined||v===null||v==="")return "--";
  if(Array.isArray(v))return `<span class="r20Result">${v.slice(0,3).map(x=>recent20LaneChip(x)).join("")}</span>`;
  const s=String(v).trim(),nums=s.match(/[1-6]/g);if(nums&&nums.length>=2)return `<span class="r20Result">${nums.slice(0,3).map(x=>recent20LaneChip(x)).join("")}</span>`;return esc(s);
}
function recent30Finish(v){
  if(v===undefined||v===null||v==="")return "--";
  const s=String(v).replace(/[\s　]+/g,"").toUpperCase();
  if(/^0?[1-6]$/.test(s))return String(Number(s));
  if(s.startsWith("S1")||s.includes("転"))return "転";
  if(s.startsWith("S")||s.includes("失"))return "失";
  if(s.startsWith("K")||s.includes("欠"))return "欠";
  if(s.startsWith("F")||s.includes("フライング"))return "F";
  if(s.startsWith("L")||s.includes("出遅"))return "L";
  return s||"--";
}
function recent30ST(v,rank){
  if(v===undefined||v===null||v==="")return "--";
  const raw=String(v).replace(/[\s　]+/g,"").toUpperCase();
  const num=Number(raw.replace(/^[FL]/,""));
  const prefix=/^[FL]/.test(raw)?raw[0]:"";
  const value=Number.isFinite(num)?`${prefix}${num.toFixed(2)}`:raw;
  const n=Number(rank);
  return `<span class="r20ST"><b>${esc(value)}</b>${Number.isInteger(n)&&n>0?`<small>(${n})</small>`:""}</span>`;
}
function recent30DateKey(row){
  const raw=String(recent20Value(row,["date","raceDate","heldAt"])||"").replace(/[^0-9]/g,"");
  return raw.length===8?raw:"";
}
let recent30VisibleRows=[];
function closeRecent30Result(){document.getElementById("recent30ResultModal")?.remove();}
function recent30ResultModal(row){
  closeRecent30Result();
  const modal=document.createElement("div");
  modal.id="recent30ResultModal";
  modal.className="r30ResultModal";
  const date=recent20Value(row,["date","raceDate","heldAt"]);
  const venue=recent20Value(row,["venue","venueName","place","stadium"])||"--";
  const grade=recent20Value(row,["grade","raceGrade","eventGrade"]);
  const frame=recent20Value(row,["lane","frame","waku","boatNo"]);
  const entry=recent20Value(row,["course","entry","courseNo","actualCourse"]);
  const finish=recent30Finish(recent20Value(row,["finish","rank","arrival","finishPlace"]));
  const st=recent20Value(row,["st","startTiming","start","actualST"]);
  const stRank=recent20Value(row,["stRank","startRank","stOrder"]);
  const move=recent20Value(row,["kimarite","winningMove","decision","move"]);
  const result=recent20Value(row,["result","combination","resultCombo","order","top3"]);
  modal.innerHTML=`<div class="r30ResultBackdrop" onclick="closeRecent30Result()"></div>
    <section class="r30ResultSheet" role="dialog" aria-modal="true" aria-label="BOAT CHECK 結果詳細">
      <button type="button" class="r30ResultClose" onclick="closeRecent30Result()" aria-label="閉じる">×</button>
      <div class="r30ResultBrand">BOAT <span>✓</span> CHECK</div>
      <div class="r30ResultTitle"><div><small>結果詳細</small><strong>${esc(venue)} ${Number(row.raceNo)||"--"}R</strong></div>${recent20Grade(grade)}</div>
      <div class="r30ResultDate">${recent20Date(date)}</div>
      <div class="r30ResultGrid">
        <div><small>選手</small><b>${esc(row.racerName||"選択選手")}</b></div>
        <div><small>枠</small><b>${recent20LaneChip(frame)}</b></div>
        <div><small>進入</small><b>${entry!==null?esc(entry):"--"}</b></div>
        <div><small>着</small><b>${esc(finish)}</b></div>
        <div><small>ST（順位）</small>${recent30ST(st,stRank)}</div>
        <div><small>決まり手</small><b>${move?esc(move):"--"}</b></div>
      </div>
      <div class="r30ResultOrder"><small>3連単結果</small>${recent20Result(result)}</div>
      <p>BOAT CHECKに保存されている公式結果データを表示しています。</p>
    </section>`;
  document.body.appendChild(modal);
}
function openRecent30Result(index){
  const row=recent30VisibleRows[Number(index)];
  if(!row)return;
  const date=recent30DateKey(row),code=String(row.venueCode||"").padStart(2,"0"),rno=Number(row.raceNo);
  const meeting=state.meetings.find(m=>String(m.venueCode).padStart(2,"0")===code);
  if(meeting&&date&&Number.isInteger(rno)){
    const view=currentDayView(meeting,date);
    const race=(view.races||[]).find(x=>Number(x.raceNo)===rno);
    if(race){
      state.currentMeeting=meeting;state.currentDayDate=date;state.currentMeetingView=view;
      state.currentRace=hydrateRaceForDisplay(race);
      history.pushState({view:"detail",code,date,raceNo:rno},"",`#race-${code}-${date}-${rno}`);
      renderRaceContext();$("home").classList.add("hidden");$("venue").classList.add("hidden");$("detail").classList.remove("hidden");
      const btn=document.querySelector('#raceDataTabs [data-panel="result"]');showRaceData("result",btn);scrollTo({top:0,behavior:"instant"});
      return;
    }
  }
  recent30ResultModal(row);
}
function recent20Selector(boats){
  const displayBoats=orderedBoatsByAssignedCourse(boats,false);
  return `<div class="r20Selector">
    ${displayBoats.map(b=>{
      const lane=Number(b.lane)||1;
      const active=lane===recent20SelectedLane;
      const pref=normalizeOriginLabel(b.origin||b.birthplace||b.prefecture||b.hometown||b.branch||b.region);
      const course=assignedCourseForLane(lane);
      return `<button type="button"
        class="r20RacerCard laneBg${lane} ${active?"active":""}"
        onclick="setRecent20Lane(${lane})">
        <span class="r20BoatNo lane${lane}">${lane}</span>
        <strong>${formatRacerNameTwoLines(cleanRacerName(b.racerName)||"--")}</strong>
        <span class="r20Meta">${esc(b.racerId||b.registrationNo||"----")}</span>
        <span class="r20Meta">${esc(b.class||"--")}</span>
        <span class="r20Meta">${b.period?esc(b.period)+"期":"--期"}</span>
        <span class="r20Meta">${esc(pref)}</span>
        ${active?`<em>選択中</em>`:""}
      </button>`;
    }).join("")}
  </div>`;
}
function renderRecent20(){
  const r=state.currentRace||{};
  const boats=hydrateBoatsForDisplay(r.boats||[]).slice(0,6);
  if(!boats.length)return `<div class="dataSection"><p class="dataPlaceholder">出走選手データを取得中です。</p></div>`;

  if(!boats.some(b=>Number(b.lane)===recent20SelectedLane)){
    recent20SelectedLane=Number(boats[0]?.lane)||1;
  }

  const selected=boats.find(b=>Number(b.lane)===recent20SelectedLane)||boats[0];
  const assignedCourse=assignedCourseForLane(selected.lane||recent20SelectedLane);
  const allHistory=recent20HistoryForBoat(selected);

  const hasCourseData=allHistory.some(x=>recent20Value(x,["course","entry","courseNo","actualCourse"])!==null);
  const courseHistory=hasCourseData
    ? allHistory.filter(x=>Number(recent20Value(x,["course","entry","courseNo","actualCourse"]))===assignedCourse)
    : allHistory;
  // A racer can have no start from the selected course even when other recent
  // results exist. Keep the screen useful and label the fallback explicitly.
  const usedFallback=hasCourseData && courseHistory.length===0 && allHistory.length>0;
  const history=(usedFallback?allHistory:courseHistory).slice(0,30);
  recent30VisibleRows=history.map(x=>({...x,racerName:cleanRacerName(selected.racerName)||""}));

  const rows=history.map((x,rowIndex)=>{
    const date=recent20Value(x,["date","raceDate","heldAt"]);
    const venue=recent20Value(x,["venue","venueName","place","stadium"]);
    const grade=recent20Value(x,["grade","raceGrade","eventGrade"]);
    const frame=recent20Value(x,["lane","frame","waku","boatNo"]);
    const entry=recent20Value(x,["course","entry","courseNo","actualCourse"]);
    const finish=recent30Finish(recent20Value(x,["finish","rank","arrival","finishPlace"]));
    const kimarite=recent20Value(x,["kimarite","winningMove","decision","move"]);
    const st=recent20Value(x,["st","startTiming","start","actualST"]);
    const stRank=recent20Value(x,["stRank","startRank","stOrder"]);
    const result=recent20Value(x,["result","combination","resultCombo","order","top3"]);
    return `<div class="r20Row">
      <div class="date"><button type="button" onclick="openRecent30Result(${rowIndex})" aria-label="${esc(date)} ${esc(venue)} ${Number(x.raceNo)}R BOAT CHECK結果詳細">${recent20Date(date)}</button></div>
      <div class="venue">${venue?esc(venue):"--"}</div>
      <div>${recent20Grade(grade)}</div>
      <div>${recent20LaneChip(frame)}</div>
      <div>${entry!==null?esc(entry):"--"}</div>
      <div class="finish">${finish!==null?esc(finish):"--"}</div>
      <div class="move">${kimarite?esc(kimarite):"--"}</div>
      <div class="st">${recent30ST(st,stRank)}</div>
      <div class="result">${recent20Result(result)}</div>
    </div>`;
  }).join("");

  const empty=`<div class="r20Empty">
    <strong>${assignedCourse}コースの直近データは未取得です</strong>
    <span>データ取得後、この表に最大30走を自動表示します。</span>
  </div>`;

  return `<div class="recent20Panel">
    <div class="r20Intro">
      <div>
        <h3>直近30走成績</h3>
        <p>${usedFallback?`${assignedCourse}コース記録なし・全コース直近を表示`:`選択選手の「${assignedCourse}コース想定」に合わせて表示`}</p>
      </div>
      <span>${history.length?`${history.length}走表示`:"データ待ち"}</span>
    </div>

    ${recent20Selector(boats)}

    <div class="r20Table">
      <div class="r20Header">
        <div>日付</div><div>場</div><div>級</div><div>枠</div>
        <div>進</div><div>着</div><div>決</div><div class="stHead">ST<small>（順位）</small></div><div>結果</div>
      </div>
      <div class="r20Body">${rows||empty}</div>
    </div>

    <div class="r20Note">
      ※ 進入コース変更で設定したコースを反映します。該当コースの記録がない場合のみ全コース直近を表示。未取得項目は「--」表示。
    </div>
  </div>`;
}
function setRecent20Lane(lane){recent20SelectedLane=Number(lane)||1;const panel=document.getElementById("courseInnerPanel");if(panel)panel.innerHTML=renderRecent20();}

function renderCourseChange(){
  const r=state.currentRace||{};
  const boats=(r.boats||[]).slice(0,6);
  if(!boats.length)return `<div class="dataSection"><p class="dataPlaceholder">出走選手データを取得中です。</p></div>`;

  const pickedCount=courseChangeSequence.length;
  const confirmedOrdered=orderedBoatsByAssignedCourse(boats,false);
  const displayBoats=pickedCount ? boats : confirmedOrdered;
  const orderText=courseChangeSequence.length
    ? courseChangeSequence.join(" - ")
    : confirmedOrdered.map(b=>b.lane).join(" - ");
  const complete=pickedCount===6;

  return `<div class="courseChangePanel">
    <div class="courseChangeHead">
      <div>
        <h3>進入コース変更</h3>
        <p>希望する進入順に艇をタップしてください</p>
      </div>
    </div>

    <div class="courseOrderSummary">
      <span>${pickedCount?`選択中 ${pickedCount}/6`:"現在の想定進入"}</span>
      <strong>${orderText}</strong>
      ${complete?`<em>決定できます</em>`:`<em class="saved">${pickedCount?`${pickedCount+1}コース目を選択`:"未変更"}</em>`}
    </div>

    <div class="sequenceGuide">
      ${[1,2,3,4,5,6].map(c=>{
        const lane=courseChangeSequence[c-1];
        return `<div class="${lane?"filled":""}">
          <b>${c}</b>
          <span>${lane?`${lane}号艇`:`${c}コース`}</span>
        </div>`;
      }).join("")}
    </div>

    <div class="courseSequenceGrid">
      ${boats.map(b=>{
        const lane=Number(b.lane)||1;
        const seqIndex=courseChangeSequence.indexOf(lane);
        const selected=seqIndex>=0;
        const pref=normalizeOriginLabel(b.origin||b.birthplace||b.prefecture||b.hometown||b.branch||b.region);
        return `<button type="button"
          class="courseSequenceCard laneBg${lane} ${selected?"selected":""}"
          onclick="toggleCourseSequenceLane(${lane})">
          <span class="ccBoat lane${lane}">${lane}</span>
          <strong>${formatRacerNameTwoLines(cleanRacerName(b.racerName)||"--")}</strong>
          <small>${esc(b.racerId||b.registrationNo||"----")}</small>
          <small>${esc(b.class||"--")} / ${b.period?esc(b.period)+"期":"--期"}</small>
          <small>${esc(pref)}</small>
          ${selected?`<em>${seqIndex+1}コース</em>`:`<i>タップして選択</i>`}
        </button>`;
      }).join("")}
    </div>

    <div class="courseSequenceHelp">
      <b>${complete?"6艇すべて選択済み":"左からの順番ではなく、タップした順番で決まります"}</b>
      <span>${complete?"「この進入で決定」を押すとコース別勝率・直近30走へ反映します。":"例：3号艇→1号艇→2号艇…と押すと、3-1-2…の進入になります。"}</span>
    </div>

    <div class="courseChangeActions">
      <button type="button" class="reset" onclick="resetPendingCourseAssignments()">初期位置に戻す</button>
      <button type="button" class="confirm ${complete?"changed":""}" ${complete?"":"disabled"} onclick="commitCourseAssignments()">この進入で決定</button>
    </div>
  </div>`;
}


function setCoursePeriod(period){
  coursePeriod=period;
  const panel=document.getElementById("courseInnerPanel");
  if(panel)panel.innerHTML=renderCourseRate();
}

function setCourseSubTab(tab){
  courseSubTab=tab;
  if(tab==="last20")loadOnce("history",loadRecent20Data).catch(console.warn);
  if(tab==="rate")loadOnce("course",loadCourseStatsData).catch(console.warn);
  if(tab==="change") openCourseChangeEditor();
  const panel=document.getElementById("courseInnerPanel");
  if(!panel)return;
  if(tab==="rate") panel.innerHTML=renderCourseRate();
  else if(tab==="last20") panel.innerHTML=renderRecent20();
  else panel.innerHTML=renderCourseChange();
  document.querySelectorAll(".courseSubTabs button").forEach(
    b=>b.classList.toggle("active",b.dataset.courseTab===tab)
  );
}

function renderCourseInfo(){
  return `<div class="coursePanelPro">
    <div class="courseSubTabs">
      <button data-course-tab="rate"
        class="${courseSubTab==="rate"?"active":""}"
        onclick="setCourseSubTab('rate')">コース別勝率</button>
      <button data-course-tab="last20"
        class="${courseSubTab==="last20"?"active":""}"
        onclick="setCourseSubTab('last20')">直近30走成績</button>
      <button data-course-tab="change"
        class="${courseSubTab==="change"?"active":""}"
        onclick="setCourseSubTab('change')">進入コース変更</button>
    </div>
    <div id="courseInnerPanel">
      ${courseSubTab==="rate"
        ? renderCourseRate()
        : courseSubTab==="last20"
          ? renderRecent20()
          : renderCourseChange()}
    </div>
  </div>`;
}

function formatRacerNameTwoLines(name){
  const s=String(name||"--").trim();
  if(!s || s==="--") return "--";
  const parts=s.split(/\s+/).filter(Boolean);
  if(parts.length>=2){
    return `${esc(parts[0])}<br>${esc(parts.slice(1).join(""))}`;
  }
  // If official data has no space, keep short names on one line.
  // Longer names are visually split near the middle.
  const chars=Array.from(s);
  if(chars.length>=5){
    const cut=Math.ceil(chars.length/2);
    return `${esc(chars.slice(0,cut).join(""))}<br>${esc(chars.slice(cut).join(""))}`;
  }
  return esc(s);
}

function formatMetricValue(v, suffix="", digits=null){
  if(v===undefined||v===null||v==="")return "--";
  if(typeof v==="number" && Number.isFinite(v)){
    return `${digits!==null ? v.toFixed(digits) : String(v)}${suffix}`;
  }
  const s=String(v).trim();
  if(!s || s==="--") return "--";
  if(digits!==null){
    const clean=s.replace(/[％%]/g,"").replace(/,/g,"");
    if(/^-?\d+(?:\.\d+)?$/.test(clean)) return `${Number(clean).toFixed(digits)}${suffix}`;
  }
  return suffix && !s.endsWith(suffix) ? `${s}${suffix}` : s;
}
function fmtStat(v, suffix="", digits=null){
  if(v===undefined||v===null||v==="")return "--";
  return esc(formatMetricValue(v, suffix, digits));
}
function firstStat(obj, keys){
  for(const k of keys){
    const parts=k.split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined||v===null)break;
      v=v[p];
    }
    if(v!==undefined&&v!==null&&v!=="")return v;
  }
  return null;
}
function normalizeBranchLabel(v){
  if(v===undefined||v===null||v==="") return "--";
  return String(v).replace(/支部$/,'').trim() || "--";
}

function normalizeOriginLabel(v){
  if(v===undefined||v===null||v==="") return "--";
  return String(v).replace(/支部$/,'').trim() || "--";
}

function fmtWeight(v){
  if(v===undefined||v===null||v==="") return "--";
  const s=String(v);
  return /kg/i.test(s) ? esc(s) : `${esc(s)}kg`;
}

function racerHistory(b){
  const id=String(b.racerId||b.registrationNo||"");
  return {...(state.racerOverallById?.[id]||{}),...(state.entryDetails?.byRacer?.[id]||{})};
}
function racerMetric(b, group, period){
  const history=racerHistory(b)?.periods?.[period];
  if(history && ["quinella","trifecta","st"].includes(group)){
    if(!history.entryCount)return "対象なし";
    if(history[group]!=null)return history[group];
  }
  if(group==="st" && period==="meet"){
    const rows=(b.meetResults||[]).filter(x=>x.source==="official_result");
    const seen=new Map();
    for(const row of rows)seen.set(`${row.day}:${row.raceNo}`,row);
    const values=[...seen.values()].filter(x=>!/[FL]/i.test(String(x.finish))).map(x=>String(x.st??"")).filter(x=>/^(?:0)?\.\d+$/.test(x)).map(Number);
    if(values.length)return values.reduce((a,b)=>a+b,0)/values.length;
  }
  const aliases={
    winRate:{
      national:["stats.winRate.national","winRate.national","nationalWinRate"],
      local:["stats.winRate.local","winRate.local","localWinRate"],
      m1:["stats.winRate.m1","winRate.m1","winRate1m"],
      m3:["stats.winRate.m3","winRate.m3","winRate3m"]
    },
    quinella:{
      national:["stats.quinella.national","quinella.national","national2Rate","twoRate.national"],
      local:["stats.quinella.local","quinella.local","local2Rate","twoRate.local"],
      m1:["stats.quinella.m1","quinella.m1","twoRate1m"],
      m3:["stats.quinella.m3","quinella.m3","twoRate3m"]
    },
    trifecta:{
      national:["stats.trifecta.national","trifecta.national","national3Rate","threeRate.national"],
      local:["stats.trifecta.local","trifecta.local","local3Rate","threeRate.local"],
      m1:["stats.trifecta.m1","trifecta.m1","threeRate1m"],
      m3:["stats.trifecta.m3","trifecta.m3","threeRate3m"]
    },
    st:{
      meet:["stats.st.meet","st.meet","meetAvgST"],
      m1:["stats.st.m1","st.m1","avgST1m"],
      m3:["stats.st.m3","st.m3","avgST3m"]
    }
  };
  return firstStat(b,aliases[group]?.[period]||[]);
}
function parseRankableNumber(v){
  if(v===undefined||v===null||v===""||v==="--") return null;
  if(typeof v==="number" && Number.isFinite(v)) return v;
  const s=String(v).replace(/[％%歳期kgＫＧ]/g,"").replace(/,/g,"").trim();
  if(!s || s==="--") return null;
  const m=s.match(/-?\d+(?:\.\d+)?/);
  if(!m) return null;
  const num=Number(m[0]);
  return Number.isFinite(num) ? num : null;
}
function rankHighlightCells(values, mode="desc", tints=[], digits=null){
  const items=values.map((v,i)=>({i,v:parseRankableNumber(v)})).filter(x=>x.v!==null);
  if(items.length<2) return values.map((v,i)=>`<td class="${tints[i]||''}">${fmtStat(v,"",digits)}</td>`);
  items.sort((a,b)=>mode==="asc" ? a.v-b.v : b.v-a.v);
  const first=items[0]?.i;
  let second=null;
  for(const item of items){ if(item.i!==first){ second=item.i; break; } }
  return values.map((v,i)=>{
    const cls=[tints[i]||''];
    if(i===first) cls.push('riBest1');
    else if(i===second) cls.push('riBest2');
    return `<td class="${cls.filter(Boolean).join(' ')}">${fmtStat(v,"",digits)}</td>`;
  });
}
function rowCells(values, suffix="", mode=null, tints=[], digits=null){
  const displayVals=values.map(v=>formatMetricValue(v, suffix, digits));
  if(!mode) return displayVals.map((v,i)=>`<td class="${tints[i]||''}">${fmtStat(v)}</td>`).join('');
  return rankHighlightCells(displayVals, mode, tints, digits).join('');
}

function renderRacerInfo(){
  const r=state.currentRace||{};
  const boats=(r.boats||[]).slice(0,6);
  if(!boats.length){
    return `<div class="qdh"><b>選手情報</b><span>公開情報を取得中</span></div><p>出走選手データを取得中です。</p>`;
  }

  const before=r.beforeData||[];
  const readings=[];
  const sts=boats.map(b=>Number(b.avgST)).filter(v=>Number.isFinite(v)&&v>=0&&v<1);
  if(sts.length===6)readings.push(`平均STの最大差 ${((Math.max(...sts)-Math.min(...sts))*100).toFixed(0)}/100秒`);
  else readings.push("平均STに未取得項目あり");
  const motors=boats.map(b=>Number(b.motorTwoRate)).filter(v=>Number.isFinite(v)&&v>0);
  if(motors.length===6)readings.push(`モーター2連率の最大差 ${(Math.max(...motors)-Math.min(...motors)).toFixed(1)}pt`);
  else readings.push("モーター比較に未取得項目あり");
  if(before.length===6){
    const changed=before.some(b=>Number(b.course)>0&&Number(b.course)!==Number(b.lane));
    readings.push(changed?"展示進入に変更あり":"展示進入の変更なし");
  }else readings.push("展示情報の公開待ち");
  const wind=Number(r.weather?.windSpeed);
  if(r.weather?.windSpeed!==undefined&&Number.isFinite(wind))readings.push(`風速 ${wind}m（波高 ${r.weather?.waveHeight??"--"}cm）`);
  else readings.push("気象情報の公開待ち");
  readings.push(r.odds?.official?`オッズ：${oddsDisplayStamp()}`:"オッズの公開待ち");
  const skipChecks=`<section class="skipChecks"><div><b>見送りチェック</b><span>断定的な予想ではなく、確認するための材料です</span></div><ul>${readings.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></section>`;

  const metricRow=(label, group, period, suffix="", rankMode="desc", digits=null)=>{
    const values=boats.map(b=>racerMetric(b,group,period));
    return `<tr>
      <th class="riSub">${label}</th>
      ${rowCells(values,suffix,rankMode,[],digits)}
    </tr>`;
  };

  const simpleRow=(label, getter, suffix="", rankMode=null, digits=null)=>{
    const values=boats.map(b=>getter(b));
    return `<tr>
      <th class="riMain">${label}</th>
      ${rowCells(values,suffix,rankMode,[],digits)}
    </tr>`;
  };

  const profileRow=(label,getter)=>{
    return `<tr>
      <th class="riMain">${label}</th>
      ${boats.map(b=>{
        const v=getter(b);
        return `<td>${v===undefined||v===null||v===""?"--":esc(v)}</td>`;
      }).join("")}
    </tr>`;
  };

  const finishingRows=["逃げ","差し","まくり","まくり差し"].map(key=>{
    const values=boats.map(b=>racerHistory(b)?.kimarite?.[key] ?? firstStat(b,[
      `stats.kimarite.${key}`,
      `kimarite.${key}`,
      `finishMoves.${key}`
    ]));
    return `<tr><th class="riSub">${key}</th>${rowCells(values,"","desc")}</tr>`;
  }).join("");

  const flyingDate=b=>racerHistory(b)?.lastFlyingDate ?? firstStat(b,["flying.date","stats.flying.date","flyingDate"]);
  const flyingBreak=b=>racerHistory(b)?.flyingBreakStart ?? firstStat(b,["flying.breakStart","stats.flying.breakStart","flyingBreakStart"]);
  const flyingRemain=b=>racerHistory(b)?.flyingUnserved ?? firstStat(b,["flying.unserved","stats.flying.unserved","flyingUnserved"]);
  const accident=b=>racerHistory(b)?.accident?.rate ?? firstStat(b,["stats.accidentRate","accidentRate"]);
  const semiFinals=b=>racerHistory(b)?.semiFinals;
  const finals=b=>racerHistory(b)?.finals;
  const wins=b=>racerHistory(b)?.championships ?? firstStat(b,["stats.championships","championships","wins"]);

  return `${skipChecks}<div class="racerInfoPro">
    <div class="racerInfoTop">
      <div>
        <h3>選手情報</h3>
        <p>6艇の主要データを横並びで比較</p>
      </div>
      <span>未取得項目は -- 表示</span>
    </div>

    <div class="racerUnifiedSheet">
      ${proRacerStrip(boats,"出走表")}

      <div class="racerTableWrap racerProData">
        <table class="racerCompareTable racerCompareDataOnly">
          <tbody>
            <tr class="riGroup"><th colspan="7">基本情報</th></tr>
            ${profileRow("登録番号",b=>b.racerId||b.registrationNo||"----")}
            ${profileRow("級",b=>b.class||"--")}
            ${profileRow("支部",b=>normalizeBranchLabel(b.branch||b.region))}
            ${profileRow("出身地",b=>normalizeOriginLabel(b.origin||b.birthplace||b.prefecture||b.hometown))}
            ${profileRow("期",b=>b.period?`${b.period}期`:"--期")}
            ${profileRow("年齢",b=>b.age!=null?`${b.age}歳`:"--歳")}
            ${profileRow("体重",b=>fmtWeight(firstStat(b,["weight","bodyWeight","stats.weight","stats.bodyWeight"])))}

            <tr class="riGroup"><th colspan="7">勝率</th></tr>
            ${metricRow("全国","winRate","national","","desc",2)}
            ${metricRow("当地","winRate","local","","desc",2)}
            ${metricRow("直近1ヶ月","winRate","m1","","desc",2)}
            ${metricRow("直近3ヶ月","winRate","m3","","desc",2)}

            <tr class="riGroup"><th colspan="7">2連対率</th></tr>
            ${metricRow("全国","quinella","national","%","desc",2)}
            ${metricRow("当地","quinella","local","%","desc",2)}
            ${metricRow("直近1ヶ月","quinella","m1","%","desc",2)}
            ${metricRow("直近3ヶ月","quinella","m3","%","desc",2)}

            <tr class="riGroup"><th colspan="7">3連対率</th></tr>
            ${metricRow("全国","trifecta","national","%","desc",2)}
            ${metricRow("当地","trifecta","local","%","desc",2)}
            ${metricRow("直近1ヶ月","trifecta","m1","%","desc",2)}
            ${metricRow("直近3ヶ月","trifecta","m3","%","desc",2)}

            <tr class="riGroup"><th colspan="7">平均スタート</th></tr>
            ${metricRow("今節","st","meet","","asc",2)}
            ${metricRow("直近1ヶ月","st","m1","","asc",2)}
            ${metricRow("直近3ヶ月","st","m3","","asc",2)}

            <tr class="riGroup"><th colspan="7">決まり手数（過去１年）</th></tr>
            ${finishingRows}

            <tr class="riGroup"><th colspan="7">フライング</th></tr>
            ${simpleRow("直近F日（過去１年）",flyingDate)}
            ${simpleRow("F休み予定日",flyingBreak)}
            ${simpleRow("未消化数",flyingRemain,"","asc",0)}

            <tr class="riGroup"><th colspan="7">その他</th></tr>
            ${simpleRow("事故率",accident,"","asc",2)}
            ${simpleRow("準優進出数（過去１年）",semiFinals,"","desc",0)}
            ${simpleRow("優出数（過去１年）",finals,"","desc",0)}
            ${simpleRow("優勝数（過去１年）",wins,"","desc",0)}
          </tbody>
        </table>
      </div>
    </div>

    <div class="racerInfoNote">※ 直近１・３か月は公式結果から集計（集計最終日：${esc(state.entryDetails?.to||state.courseStatsMeta?.to||"未取得")}）。F休み予定日は未消化Fがある選手について、公式の現在・今後の斡旋最終日の翌日を表示（斡旋追加で変わる場合があります）。未消化数は今期F数と完了済み30日間の無出走期間から判定。事故率は2026年9月13日の級別審査データを初期値に、以後は公式結果と各場公式出走表の減点者を加算して自動計算。公式PDFを取得できなかった日は次回更新で再確認します。未取得は「--」、出走なしは「対象なし」。</div>
  </div>`;
}

function motorPath(obj, keys){
  for(const key of keys){
    const parts=String(key).split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}


function boatObjectForBoat(boat, race){
  const direct=[
    boat?.boat, boat?.boatData, boat?.boatStats,
    boat?.equipment?.boat, boat?.stats?.boat, boat?.hull
  ];
  for(const x of direct){
    if(x && typeof x==="object" && !Array.isArray(x)) return x;
  }

  const root=race?.boatData || race?.boatsData || race?.boatStats || race?.hulls || null;
  if(!root) return {};

  if(Array.isArray(root)){
    return root.find(x=>
      Number(x?.lane||x?.boatNo||x?.frame)===Number(boat?.lane) ||
      String(x?.racerId||x?.registrationNo||"")===String(boat?.racerId||boat?.registrationNo||"")
    ) || {};
  }

  if(typeof root==="object"){
    const lane=Number(boat?.lane)||1;
    const candidates=[
      root[lane],root[String(lane)],root[`lane${lane}`],root[`boat${lane}`],
      root.byLane?.[lane],root.byLane?.[String(lane)]
    ];
    for(const x of candidates){
      if(x && typeof x==="object") return x;
    }
  }
  return {};
}

function boatMetric(boatInfo, boat, metric){
  const aliases={
    no:[
      "boatNo","boatNumber","number","no","id",
      "hullNo","hullNumber","boat.no","boat.number"
    ],
    rank:[
      "rank","boatRank","ranking","hullRank","boat.rank"
    ],
    win:[
      "winRate","rate","boatWinRate","hullWinRate","boat.winRate"
    ],
    first:[
      "firstRate","win1Rate","firstPlaceRate","oneRate","boat.firstRate"
    ],
    three:[
      "threeRate","trifectaRate","threePlaceRate","boat.threeRate"
    ],
    two:[
      "twoRate","quinellaRate","twoPlaceRate","boat.twoRate"
    ]
  };

  let v=motorPath(boatInfo,aliases[metric]||[metric]);
  if(v!==null) return v;

  const boatAliases={
    no:["boatNo","boatNumber","hullNo","hullNumber","equipment.boatNo","equipment.hullNo"],
    rank:["boatRank","hullRank","boat.rank"],
    win:["boatWinRate","hullWinRate","boat.winRate"],
    first:["boatFirstRate","hullFirstRate","boat.firstRate"],
    three:["boatThreeRate","boat3Rate","hullThreeRate","boat.threeRate"],
    two:["boatTwoRate","boat2Rate","hullTwoRate","boat.twoRate"]
  };
  return firstStat(boat,boatAliases[metric]||[]);
}

function boatBasicTable(boats,boatInfos){
  const defs=[
    {label:"ボート番号",key:"no",fmt:v=>motorFmt(v),rank:null},
    {label:"ボート順位",key:"rank",fmt:v=>motorRankText(v),rank:"asc"},
    {label:"勝率",key:"win",fmt:v=>motorFmt(v,"",2),rank:"desc"},
    {label:"1着率",key:"first",fmt:v=>motorFmt(v,"%",1),rank:"desc"},
    {label:"3連対率",key:"three",fmt:v=>motorFmt(v,"%",1),rank:"desc"},
    {label:"2連対率",key:"two",fmt:v=>motorFmt(v,"%",1),rank:"desc"}
  ];

  return `<div class="motorBasicTable boatBasicTable">
    <div class="motorBasicHead">
      <div>項目</div>
      ${boats.map((b,i)=>{
        const no=boatMetric(boatInfos[i],b,"no");
        return `<div class="motorHeadLane laneHead${b.lane}">
          <b>${b.lane}号艇</b>
          <span>${no!==null&&no!==undefined&&no!==""?`${esc(no)}号艇`:"--号艇"}</span>
        </div>`;
      }).join("")}
    </div>
    ${defs.map(d=>{
      const vals=boats.map((b,i)=>boatMetric(boatInfos[i],b,d.key));
      const classes=d.rank?motorRankClasses(vals,d.rank,false):vals.map(()=>"");
      return `<div class="motorBasicRow">
        <div class="motorBasicLabel">${d.label}</div>
        ${vals.map((v,i)=>`<div class="motorBasicCell ${classes[i]}">${d.fmt(v)}</div>`).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

function setMotorInnerTab(tab){
  motorInnerTab=tab==="boat"?"boat":"motor";
  const panel=$("quickDataPanel");
  if(panel)panel.innerHTML=renderMotorInfo();
}

function motorObjectForBoat(boat, race){
  const direct=[
    boat?.motor, boat?.motorData, boat?.motorStats,
    boat?.equipment?.motor, boat?.stats?.motor
  ];
  const code=String(state.currentMeeting?.venueCode||state.currentMeetingView?.venueCode||"").padStart(2,"0");
  const no=String(boat?.motorNo||boat?.motor?.motorNo||boat?.motor?.number||"");
  let extra=state.entryDetails?.motorsByVenue?.[code]?.[no];
  const rawDate=String(state.currentMeeting?.date||state.dateJST||"").replaceAll("-","");
  const raceDate=rawDate.length===8?`${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`:"";
  if(extra && (!raceDate || (extra.usageStart ? raceDate<extra.usageStart : rawDate!==state.entryDetails?.targetDateJST)))extra=null;
  for(const x of direct){
    if(x && typeof x==="object" && !Array.isArray(x)) return {...(extra||{}),...x,rank:extra?.rank??null};
  }
  if(extra)return extra;

  const root=race?.motorData || race?.motors || race?.motorStats || null;
  if(!root) return {};

  if(Array.isArray(root)){
    return root.find(x=>
      Number(x?.lane||x?.boatNo||x?.frame)===Number(boat?.lane) ||
      String(x?.racerId||x?.registrationNo||"")===String(boat?.racerId||boat?.registrationNo||"")
    ) || {};
  }

  if(typeof root==="object"){
    const lane=Number(boat?.lane)||1;
    const candidates=[
      root[lane], root[String(lane)], root[`lane${lane}`], root[`boat${lane}`],
      root.byLane?.[lane], root.byLane?.[String(lane)]
    ];
    for(const x of candidates){
      if(x && typeof x==="object") return x;
    }
  }
  return {};
}

function motorMetric(motor, boat, metric){
  const aliases={
    no:[
      "motorNo","motorNumber","number","no","id",
      "motor.no","motor.number"
    ],
    rank:[
      "rank","motorRank","ranking","motor.rank"
    ],
    win:[
      "winRate","rate","motorWinRate","motor.winRate"
    ],
    first:[
      "firstRate","win1Rate","firstPlaceRate","oneRate","motor.firstRate"
    ],
    two:[
      "twoRate","quinellaRate","twoPlaceRate","motor.twoRate"
    ],
    three:[
      "threeRate","trifectaRate","threePlaceRate","motor.threeRate"
    ],
    starts:[
      "starts","startCount","raceCount","runs","entries","motor.starts"
    ],
    finalist:[
      "finalistCount","finals","finalCount","yushutsu","motor.finalistCount"
    ],
    champion:[
      "championships","championCount","wins","yusho","motor.championships"
    ],
    ikiashi:[
      "ikiashi","ikiAshi","straight","leg.ikiashi","legs.ikiashi","ratings.ikiashi"
    ],
    deashi:[
      "deashi","deAshi","acceleration","leg.deashi","legs.deashi","ratings.deashi"
    ],
    mawari:[
      "mawariashi","mawariAshi","turn","turning","leg.mawariashi","legs.mawariashi","ratings.mawariashi"
    ],
    maintenance:[
      "maintenance","midMaintenance","intermediateMaintenance","maintenanceNote","maintenanceDate","motor.maintenance"
    ]
  };
  let v=motorPath(motor, aliases[metric]||[metric]);
  if(v!==null) return v;

  // Flexible fallbacks for collector schemas where motor fields are stored directly on boat.
  const boatAliases={
    no:["motorNo","motorNumber","motor.no","equipment.motorNo"],
    rank:[],
    win:["motorWinRate","motor.winRate"],
    first:["motorFirstRate","motor.firstRate"],
    two:["motorTwoRate","motor2Rate","motor.twoRate"],
    three:["motorThreeRate","motor3Rate","motor.threeRate"],
    starts:["motorStarts","motorRaceCount","motor.starts"],
    finalist:["motorFinalistCount","motor.finalistCount"],
    champion:["motorChampionCount","motor.championships"],
    ikiashi:["motorIkiashi","motor.ikiashi"],
    deashi:["motorDeashi","motor.deashi"],
    mawari:["motorMawariashi","motor.mawariashi"],
    maintenance:["motorMaintenance","motor.maintenance"]
  };
  return firstStat(boat,boatAliases[metric]||[]);
}


function motorMoveMetric(motor, boat, move, kind){
  const moveAliases={
    escape:["escape","nige","runaway"],
    sashi:["sashi","insert"],
    makuri:["makuri","turningAttack"],
    makuriSashi:["makuriSashi","makurisashi","wrapInsert"]
  };
  const moveKeys=moveAliases[move]||[move];
  const keys=[];
  for(const mk of moveKeys){
    if(kind==="count"){
      keys.push(
        `kimarite.${mk}.count`,`kimarite.${mk}.num`,`kimarite.${mk}.value`,
        `winningMoves.${mk}.count`,`winningMoves.${mk}.num`,
        `moveStats.${mk}.count`,`moveStats.${mk}.num`,
        `${mk}Count`,`${mk}Wins`,`motor.${mk}Count`,`motorKimarite.${mk}.count`
      );
    }else{
      keys.push(
        `kimarite.${mk}.rate`,`kimarite.${mk}.winRate`,`kimarite.${mk}.ratio`,
        `winningMoves.${mk}.rate`,`winningMoves.${mk}.winRate`,
        `moveStats.${mk}.rate`,`moveStats.${mk}.winRate`,
        `${mk}Rate`,`${mk}WinRate`,`motor.${mk}Rate`,`motorKimarite.${mk}.rate`
      );
    }
  }
  let v=motorPath(motor, keys);
  if(v!==null) return v;
  const boatKeys=[];
  for(const mk of moveKeys){
    if(kind==="count"){
      boatKeys.push(`motor${mk[0].toUpperCase()+mk.slice(1)}Count`,`${mk}Count`,`${mk}Wins`);
    }else{
      boatKeys.push(`motor${mk[0].toUpperCase()+mk.slice(1)}Rate`,`${mk}Rate`,`${mk}WinRate`);
    }
  }
  return firstStat(boat, boatKeys);
}

function motorMoveCountRate(motor, boat, move){
  const count=motorMoveMetric(motor, boat, move, "count");
  const rate=motorMoveMetric(motor, boat, move, "rate");
  const countTxt=(count===undefined||count===null||count==="") ? "--" : esc(String(count));
  let rateTxt="--";
  if(rate!==undefined && rate!==null && rate!==""){
    const s=String(rate).trim();
    const clean=s.replace(/[％%]/g,"").replace(/,/g,"");
    rateTxt = /^-?\d+(?:\.\d+)?$/.test(clean) ? `${Number(clean).toFixed(1)}%` : (s.endsWith('%')||s.endsWith('％') ? esc(s) : `${esc(s)}%`);
  }
  if(countTxt==="--" && rateTxt==="--") return "--";
  return `<span class="motorMoveCombo"><b>${countTxt}</b><small>${rateTxt}</small></span>`;
}

function motorRecent20(motor, boat){
  const sources=[
    motor?.recent20, motor?.recent20Races, motor?.last20, motor?.history20,
    motor?.recentRaces, motor?.history?.recent20,
    boat?.motorRecent20, boat?.motorHistory20, boat?.motor?.recent20
  ];
  for(const s of sources){
    if(Array.isArray(s)) return s.slice(0,20);
  }
  return [];
}

function motorFmt(v, suffix="", digits=null){
  if(v===undefined || v===null || v==="") return "--";
  if(typeof v==="number" && Number.isFinite(v)){
    return `${digits!==null?v.toFixed(digits):v}${suffix}`;
  }
  const s=String(v).trim();
  if(!s || s==="--") return "--";
  if(digits!==null){
    const clean=s.replace(/[％%位]/g,"").replace(/,/g,"");
    if(/^-?\d+(?:\.\d+)?$/.test(clean)){
      return `${Number(clean).toFixed(digits)}${suffix}`;
    }
  }
  return suffix && !s.endsWith(suffix) ? `${s}${suffix}` : s;
}

function motorRankText(v){
  if(v===undefined || v===null || v==="") return "--";
  const s=String(v).trim();
  if(!s || s==="--") return "--";
  return /位$/.test(s) ? esc(s) : `${esc(s)}位`;
}

function normalizeLegRating(v){
  if(v===undefined || v===null || v==="") return "--";
  const s=String(v).trim()
    .replace(/×/g,"✕")
    .replace(/✖︎|✖/g,"✕");
  if(["◎","○","◯","△","✕"].includes(s)) return s==="◯"?"○":s;
  const n=Number(s);
  if(Number.isFinite(n)){
    if(n>=4)return "◎";
    if(n>=3)return "○";
    if(n>=2)return "△";
    return "✕";
  }
  return esc(s);
}

function motorLegScore(v){
  const s=String(normalizeLegRating(v));
  return s==="◎"?4:s==="○"?3:s==="△"?2:s==="✕"?1:null;
}

function motorRankClasses(values, mode="desc", leg=false){
  const parsed=values.map(v=>{
    if(leg) return motorLegScore(v);
    return parseRankableNumber(v);
  });
  const valid=[...new Set(parsed.filter(v=>v!==null))].sort((a,b)=>mode==="asc"?a-b:b-a);
  return parsed.map(v=>{
    if(v===null)return "";
    if(v===valid[0])return "motorBest1";
    if(valid.length>1 && v===valid[1])return "motorBest2";
    return "";
  });
}

function motorRacerHeader(boats){
  return proRacerStrip(boats,"出走表");
}

function motorBasicTable(boats, motors){
  const defs=[
    {label:"モーター番号", key:"no", fmt:v=>motorFmt(v), rank:null},
    {label:"場内順位（公式）", key:"rank", fmt:v=>motorRankText(v), rank:"asc"},
    {label:"勝率", key:"win", fmt:v=>motorFmt(v,"",2), rank:"desc"},
    {label:"1着率", key:"first", fmt:v=>motorFmt(v,"%",1), rank:"desc"},
    {label:"2連対率", key:"two", fmt:v=>motorFmt(v,"%",1), rank:"desc"},
    {label:"3連対率", key:"three", fmt:v=>motorFmt(v,"%",1), rank:"desc"},
    {label:"出走数", key:"starts", fmt:v=>motorFmt(v), rank:"desc"},
    {label:"優出数", key:"finalist", fmt:v=>motorFmt(v), rank:"desc"},
    {label:"優勝数", key:"champion", fmt:v=>motorFmt(v), rank:"desc"},
    {label:"行き足", key:"ikiashi", fmt:v=>normalizeLegRating(v), rank:"desc", leg:true},
    {label:"出足", key:"deashi", fmt:v=>normalizeLegRating(v), rank:"desc", leg:true},
    {label:"回り足", key:"mawari", fmt:v=>normalizeLegRating(v), rank:"desc", leg:true},
    {label:"逃げ 数/率", custom:(motor,boat)=>motorMoveCountRate(motor,boat,"escape"), rank:null},
    {label:"差し 数/率", custom:(motor,boat)=>motorMoveCountRate(motor,boat,"sashi"), rank:null},
    {label:"捲り 数/率", custom:(motor,boat)=>motorMoveCountRate(motor,boat,"makuri"), rank:null},
    {label:"捲り差し 数/率", custom:(motor,boat)=>motorMoveCountRate(motor,boat,"makuriSashi"), rank:null},
    {label:"中間整備", key:"maintenance", fmt:v=>v===null||v===undefined||v===""?"--":esc(v), rank:null}
  ];

  return `<div class="motorBasicTable">
    <div class="motorBasicHead">
      <div>項目</div>
      ${boats.map((b,i)=>{
        const no=motorMetric(motors[i],b,"no");
        return `<div class="motorHeadLane laneHead${b.lane}">
          <b>${b.lane}号艇</b>
          <span>${no!==null&&no!==undefined&&no!==""?`${esc(no)}号機`:"--号機"}</span>
        </div>`;
      }).join("")}
    </div>
    ${defs.map(d=>{
      const vals=d.custom ? boats.map((b,i)=>d.custom(motors[i],b,i)) : boats.map((b,i)=>motorMetric(motors[i],b,d.key));
      const classes=(d.rank && !d.custom)?motorRankClasses(vals,d.rank,!!d.leg):vals.map(()=> "");
      return `<div class="motorBasicRow">
        <div class="motorBasicLabel">${d.label}</div>
        ${vals.map((v,i)=>`<div class="motorBasicCell ${classes[i]} ${d.leg?"motorLegCell":""} ${d.custom?"motorComboCell":""}">${d.custom?v:d.fmt(v)}</div>`).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

function motorHistoryCell(item){
  if(!item) return `<div class="motorHistCell motorHistEmpty">
    <span>${meetCourseBadge(null)}</span><span>--</span><span>--</span><b>--</b>
  </div>`;

  const course=motorPath(item,["course","entry","courseNo","actualCourse","lane"]);
  const exhibition=motorPath(item,["exhibitionTime","tenjiTime","displayTime","exhibition","time"]);
  const racerClass=motorPath(item,["class","grade","racerClass","rankClass"]);
  const finishRaw=motorPath(item,["finish","rank","arrival","finishPlace","result"]);
  const finish=finishRaw===null?null:recent30Finish(finishRaw);
  const f=Number(finish);
  const cls=f===1?"motorFinish1":f===2?"motorFinish2":"";

  return `<div class="motorHistCell ${cls}">
    ${meetCourseBadge(course)}
    <span>${motorFmt(exhibition,"",2)}</span>
    <span>${racerClass?esc(racerClass):"--"}</span>
    <b>${finish!==null&&finish!==undefined&&finish!==""?esc(finish):"--"}</b>
  </div>`;
}

function motorHistoryTable(boats,motors){
  const histories=motors.map((m,i)=>motorRecent20(m,boats[i]));
  const maxRows=Math.min(20,Math.max(0,...histories.map(x=>x.length)));
  const rows=maxRows||20;

  return `<div class="motorHistoryWrap">
    <div class="motorHistoryHead">
      <div class="motorNoCol">No.</div>
      ${boats.map((b,i)=>{
        const no=motorMetric(motors[i],b,"no");
        return `<div class="motorHistoryLane laneHead${b.lane}">
          <b>${b.lane}号艇</b>
          <span>${no!==null&&no!==undefined&&no!==""?`${esc(no)}号機`:"--号機"}</span>
        </div>`;
      }).join("")}
    </div>

    <div class="motorHistorySubHead">
      <div></div>
      ${boats.map(()=>`<div class="motorHistLabels"><span>進入</span><span>展示</span><span>級</span><span>着</span></div>`).join("")}
    </div>

    ${Array.from({length:rows},(_,row)=>`<div class="motorHistoryRow">
      <div class="motorHistoryNo">${row+1}</div>
      ${boats.map((b,i)=>motorHistoryCell(histories[i]?.[row]||null)).join("")}
    </div>`).join("")}
  </div>`;
}

function equipmentIcon(type){
  const common='viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  if(type==="boat"){
    return `<svg ${common} class="equipmentSvg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 14.5h17l-2.2 3.2a3 3 0 0 1-2.5 1.3H8.2a3 3 0 0 1-2.5-1.3L3.5 14.5Z"/><path d="m7 14.5 1.5-6h7l2 6"/><path d="M10 8.5V5h4v3.5"/><path d="M4 21c1.2-.8 2.4-.8 3.6 0 1.2-.8 2.4-.8 3.6 0 1.2-.8 2.4-.8 3.6 0 1.2-.8 2.4-.8 3.6 0"/></svg>`;
  }
  if(type==="history"){
    return `<svg ${common} class="equipmentSvg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h16"/><path d="M7 4v16"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="17" r="1" fill="currentColor" stroke="none"/></svg>`;
  }
  return `<svg ${common} class="equipmentSvg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.2v2.1M12 18.7v2.1M3.2 12h2.1M18.7 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5"/><circle cx="12" cy="12" r="7.2"/></svg>`;
}

function renderMotorInfo(){
  const r=state.currentRace||{};
  const boats=(r.boats||[]).slice(0,6);
  if(!boats.length){
    return `<div class="dataSection"><p class="dataPlaceholder">出走選手データを取得中です。</p></div>`;
  }

  const motors=boats.map(b=>motorObjectForBoat(b,r));
  const boatInfos=boats.map(b=>boatObjectForBoat(b,r));

  return `<div class="motorInfoPage">
    <div class="motorPageTitle">
      <div>
        <h3>モーター・ボート情報</h3>
        <p>6艇の機力とボート成績を比較</p>
      </div>
      <span>未取得は --</span>
    </div>

    <div class="motorInnerTabs">
      <button class="${motorInnerTab==="motor"?"active":""}" onclick="setMotorInnerTab('motor')">
        <span class="motorTabIcon">${equipmentIcon("motor")}</span>
        <span>モーター情報</span>
      </button>
      <button class="${motorInnerTab==="boat"?"active":""}" onclick="setMotorInnerTab('boat')">
        <span class="motorTabIcon">${equipmentIcon("boat")}</span>
        <span>ボート情報</span>
      </button>
    </div>

    ${motorInnerTab==="motor"?`<p class="entryDataNote">${(()=>{const m=motors.find(x=>x.sourceUrl);return m?`公式モーター表：${esc(m.asOf||"更新日未確認")}時点。使用開始：${esc(m.usageStart||"未確認")}。順位は${esc(m.rankBasis||"公式掲載順")}順。2・3連対率は出走表を優先。履歴・決まり手率は確認済み使用期間の公式結果から集計（率の分母は出走数）。`:'公式成績の補完データが未取得の場です。確認できない項目は -- で表示します。';})()}</p>`:''}
    ${motorInnerTab==="motor"?`
      <div class="motorConnectedFrame motorProConnected">
        ${motorRacerHeader(boats)}
        <div class="motorSectionBar">
          <b>${equipmentIcon("motor")}<span>モーター基本データ</span></b>
          <span>モーターの力を6艇比較</span>
        </div>
        ${motorBasicTable(boats,motors)}

        <div class="motorSectionBar motorHistoryBar">
          <b>${equipmentIcon("history")}<span>モーター過去20走成績</span></b>
          <span>進入・展示・級・着</span>
        </div>
        ${motorHistoryTable(boats,motors)}
      </div>
    `:`
      <div class="motorConnectedFrame boatConnectedFrame motorProConnected">
        ${motorRacerHeader(boats)}
        <div class="motorSectionBar boatSectionBar">
          <b>${equipmentIcon("boat")}<span>ボート基本データ</span></b>
          <span>ボート成績を6艇比較</span>
        </div>
        ${boatBasicTable(boats,boatInfos)}
      </div>
    `}

    <div class="motorLegend">
      <span><i class="first"></i>1位（ベスト値）</span>
      <span><i class="second"></i>2位（次点）</span>
      <small>※ 未取得項目は「--」で表示します。</small>
    </div>
  </div>`;
}

function beforeValue(obj, keys){
  for(const key of keys){
    const parts=String(key).split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}

function beforeDataForBoat(boat, race){
  const lane=Number(boat?.lane);
  const sameBoat=x=>{
    if(!x || typeof x!=="object") return false;
    const n=Number(x.lane??x.boatNo??x.frame);
    if(n>=1 && n<=6) return n===lane;
    const id=String(x.racerId??x.registrationNo??"");
    const target=String(boat?.racerId??boat?.registrationNo??"");
    return Boolean(id && target && id===target);
  };
  let data={};
  const root=race?.beforeData || race?.before || race?.exhibition || race?.exhibitionData || race?.preRaceData;
  if(Array.isArray(root)) data={...(root.find(sameBoat)||{})};
  else if(root && typeof root==="object"){
    const list=root.boats || root.runners;
    const row=Array.isArray(list)?list.find(sameBoat):null;
    data={...(row || root.byLane?.[lane] || root[lane] || root[`lane${lane}`] || root[`boat${lane}`] || {})};
  }
  for(const local of [boat?.before,boat?.beforeData,boat?.exhibition,boat?.exhibitionData,boat?.preRace,boat?.preRaceData,boat?.currentExhibition]){
    if(local && typeof local==="object" && !Array.isArray(local)){
      for(const [key,value] of Object.entries(local)) if(value!==null && value!==undefined && value!=="") data[key]=value;
      break;
    }
  }
  const rows=race?.startExhibition;
  if(Array.isArray(rows) && rows.length){
    const valid=rows.length===6 && rows.every(x=>Number.isInteger(Number(x.lane)) && Number(x.lane)>=1 && Number(x.lane)<=6 && Number.isInteger(Number(x.course)) && Number(x.course)>=1 && Number(x.course)<=6) && new Set(rows.map(x=>Number(x.lane))).size===6 && new Set(rows.map(x=>Number(x.course))).size===6;
    if(valid){
      const row=rows.find(sameBoat);
      if(row){data.course=Number(row.course);data.st=row.rawST??row.st;}
    }else{
      // Do not present corrupt old data as an official ST or course.
      data._invalidStart=true;
    }
  }
  return data;
}

function beforeMetric(d, boat, key){
  if(d?._invalidStart && (key==="course" || key==="st")) return null;
  const aliases={
    course:["course","entry","courseNo","actualCourse","startCourse"],
    exhibition:["exhibitionTime","tenjiTime","displayTime","exhibition","time"],
    st:["st","startTiming","startTime","start"],
    weight:["weight","bodyWeight","racerWeight"],
    adjust:["weightAdjustment","adjustWeight","weightAdjust","adjustment"],
    parts:["partsExchange","partExchange","parts","replacement","exchange"],
    tilt:["tilt","tiltAngle","tiltValue"],
    lap:["lapTime","oneLapTime","lap","oneRoundTime"],
    turn:["turnTime","mawariashiTime","turningTime","cornerTime"],
    straight:["straightTime","straight","straightRunTime"]
  };
  let v=beforeValue(d,aliases[key]||[key]);
  if(v!==null) return v;

  const boatAliases={
    course:["before.course","exhibition.course"],
    exhibition:["exhibitionTime","tenjiTime","before.exhibitionTime","exhibition.time"],
    st:["exhibitionST","beforeST","before.st","exhibition.st"],
    weight:["weight","bodyWeight"],
    adjust:["weightAdjustment","adjustWeight"],
    parts:["partsExchange","partExchange"],
    tilt:["tilt","tiltAngle"],
    lap:["lapTime","oneLapTime"],
    turn:["turnTime","mawariashiTime"],
    straight:["straightTime"]
  };
  return firstStat(boat,boatAliases[key]||[]);
}

function beforeRacerHeader(boats){
  return proRacerStrip(boats,"出走表");
}

function beforeFmt(v, digits=null, suffix=""){
  if(v===undefined||v===null||v==="") return "--";
  if(typeof v==="number" && Number.isFinite(v)){
    return `${digits!==null?v.toFixed(digits):v}${suffix}`;
  }
  const s=String(v).trim();
  if(!s) return "--";
  if(digits!==null){
    const clean=s.replace(/[％%kgＫＧ]/g,"").replace(/,/g,"");
    if(/^-?\d+(?:\.\d+)?$/.test(clean)) return `${Number(clean).toFixed(digits)}${suffix}`;
  }
  return suffix && !s.endsWith(suffix) ? `${esc(s)}${suffix}` : esc(s);
}

function beforeTilt(v){
  if(v===undefined||v===null||v==="") return {text:"--",danger:false};
  const n=parseRankableNumber(v);
  const text=beforeFmt(v,1);
  return {text,danger:n!==null && n>=1.5 && n<=3.0};
}

function beforeCourseChip(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<1||n>6) return `<span class="beforeCourse empty">--</span>`;
  return `<span class="beforeCourse lane${n}">${n}</span>`;
}

function beforeTable(boats,data){
  const rows=[
    {label:"進入コース",key:"course",fmt:v=>beforeCourseChip(v)},
    {label:"展示タイム",key:"exhibition",fmt:v=>beforeFmt(v,2)},
    {label:"ST",key:"st",fmt:v=>beforeFmt(v,2)},
    {label:"体重",key:"weight",fmt:v=>beforeFmt(v,1,"kg")},
    {label:"重量調整",key:"adjust",fmt:v=>beforeFmt(v,1,"kg")},
    {label:"部品交換",key:"parts",fmt:v=>v===null||v===undefined||v===""?"--":esc(v)},
    {label:"チルト",key:"tilt",tilt:true}
  ];

  return `<div class="beforeCompareTable">
    <div class="beforeCompareHead">
      <div>項目</div>
      ${boats.map(b=>`<div class="beforeHeadLane laneHead${b.lane}">${b.lane}</div>`).join("")}
    </div>
    ${rows.map(row=>{
      const vals=boats.map((b,i)=>beforeMetric(data[i],b,row.key));
      return `<div class="beforeCompareRow">
        <div class="beforeCompareLabel">${row.label}</div>
        ${vals.map(v=>{
          if(row.tilt){
            const t=beforeTilt(v);
            return `<div class="beforeCompareCell ${t.danger?"tiltDanger":""}">${t.text}</div>`;
          }
          return `<div class="beforeCompareCell">${row.fmt(v)}</div>`;
        }).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

function beforeRankClasses(values,mode="asc"){
  const nums=values.map(parseRankableNumber);
  const valid=[...new Set(nums.filter(v=>v!==null))].sort((a,b)=>mode==="asc"?a-b:b-a);
  return nums.map(v=>{
    if(v===null)return "";
    if(v===valid[0])return "beforeBest1";
    if(valid.length>1 && v===valid[1])return "beforeBest2";
    return "";
  });
}

function renderOriginalExhibition(boats,data){
  const defs=[
    {label:"展示タイム",key:"exhibition",digits:2,mode:"asc"},
    {label:"一周タイム",key:"lap",digits:2,mode:"asc"},
    {label:"まわり足タイム",key:"turn",digits:2,mode:"asc"},
    {label:"直線タイム",key:"straight",digits:2,mode:"asc"},
    {label:"チルト",key:"tilt",digits:1,mode:null,tilt:true}
  ];
  return `<div class="beforeOriginalTable">
    <div class="beforeOriginalHead">
      <div>項目</div>
      ${boats.map(b=>`<div class="beforeHeadLane laneHead${b.lane}">${b.lane}</div>`).join("")}
    </div>
    ${defs.map(row=>{
      const vals=boats.map((b,i)=>beforeMetric(data[i],b,row.key));
      const cls=row.mode?beforeRankClasses(vals,row.mode):vals.map(()=> "");
      return `<div class="beforeOriginalRow">
        <div class="beforeOriginalLabel">${row.label}</div>
        ${vals.map((v,i)=>{
          if(row.tilt){
            const t=beforeTilt(v);
            return `<div class="beforeOriginalCell ${t.danger?"tiltDanger":""}">${t.text}</div>`;
          }
          return `<div class="beforeOriginalCell ${cls[i]}">${beforeFmt(v,row.digits)}</div>`;
        }).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

function beforeWeather(race){
  const root=race?.weather || race?.weatherData || race?.conditions || race?.before?.weather || race?.beforeData?.weather || {};
  const direction=beforeValue(root,["windDirection","windDir","direction"]) ?? firstStat(race,["windDirection","weather.windDirection"]);
  const speed=beforeValue(root,["windSpeed","wind","speed"]) ?? firstStat(race,["windSpeed","weather.windSpeed"]);
  const wave=beforeValue(root,["waveHeight","wave","waves"]) ?? firstStat(race,["waveHeight","weather.waveHeight"]);
  const weather=beforeValue(root,["weather","condition","sky"]) ?? firstStat(race,["weatherName","weather.condition"]);
  const air=beforeValue(root,["airTemperature","temperature","airTemp"]) ?? firstStat(race,["temperature","airTemperature"]);
  const water=beforeValue(root,["waterTemperature","waterTemp"]) ?? firstStat(race,["waterTemperature"]);
  return {direction,speed,wave,weather,air,water};
}

function beforeWindArrow(direction){
  const d=String(direction||"").toUpperCase();
  const map={N:0,北:0,NE:45,北東:45,E:90,東:90,SE:135,南東:135,S:180,南:180,SW:225,南西:225,W:270,西:270,NW:315,北西:315};
  let deg=map[d];
  if(deg===undefined){
    for(const [k,v] of Object.entries(map)){
      if(d.includes(k)){deg=v;break;}
    }
  }
  return Number.isFinite(deg)?deg:0;
}

function renderWeatherPanel(race){
  const w=beforeWeather(race);
  const angle=beforeWindArrow(w.direction);
  const f=(v,suffix="")=>v===undefined||v===null||v===""?"--":`${esc(v)}${suffix}`;
  return `<div class="beforeWeatherBlock">
    <div class="beforeSubSectionTitle">水面気象状況</div>
    <div class="weatherGrid">
      <div class="weatherWind">
        <small>風向</small>
        <div class="windCompass">
          <span>N</span>
          <i style="transform:rotate(${angle}deg)">▲</i>
        </div>
        <b>${w.direction?esc(w.direction):"--"}</b>
      </div>
      <div><small>風速</small><strong>${f(w.speed,"m/s")}</strong></div>
      <div><small>波高</small><strong>${f(w.wave,"cm")}</strong></div>
      <div><small>天候</small><strong>${w.weather?esc(w.weather):"--"}</strong></div>
      <div><small>気温</small><strong>${f(w.air,"℃")}</strong></div>
      <div><small>水温</small><strong>${f(w.water,"℃")}</strong></div>
    </div>
  </div>`;
}

function raceVisualLaneColor(lane){
  return {
    1:"#f7f8fa",
    2:"#20262d",
    3:"#ef3340",
    4:"#2d63db",
    5:"#f2d300",
    6:"#109447"
  }[Number(lane)||1];
}

function raceVisualTextColor(lane){
  return [2,3,4,6].includes(Number(lane)) ? "#fff" : "#111";
}

function raceVisualSTMeta(v){
  if(v===undefined||v===null||v===""||v==="--"){
    return {kind:"missing",value:null,label:"--"};
  }

  let s=String(v).trim().toUpperCase().replace(/^0(?=\.)/,"");
  if(!s)return {kind:"missing",value:null,label:"--"};

  if(/^F/.test(s)){
    const n=Number(s.replace(/^F/,""));
    return {
      kind:"f",
      value:Number.isFinite(n)?Math.abs(n):null,
      label:Number.isFinite(n)?`F${n.toFixed(2).replace(/^0/,"")}`:s
    };
  }

  if(/^L/.test(s)){
    const n=Number(s.replace(/^L/,""));
    return {
      kind:"l",
      value:Number.isFinite(n)?Math.abs(n):null,
      label:Number.isFinite(n)?`L${n.toFixed(2).replace(/^0/,"")}`:s
    };
  }

  const n=Number(s);
  if(Number.isFinite(n)){
    return {
      kind:"normal",
      value:Math.abs(n),
      label:n.toFixed(2).replace(/^0/,"")
    };
  }

  const m=s.match(/-?\d+(?:\.\d+)?/);
  if(m){
    const num=Math.abs(Number(m[0]));
    return {
      kind:"normal",
      value:Number.isFinite(num)?num:null,
      label:Number.isFinite(num)?num.toFixed(2).replace(/^0/,""):s
    };
  }
  return {kind:"missing",value:null,label:esc(s)};
}

function raceVisualPosition(v){
  const meta=raceVisualSTMeta(v);

  // 採用デザインに合わせて、スタートラインは少し右寄り。
  // ここで返す位置は「舟の中心」ではなく「舟の先端」の位置。
  const line=78;
  const leftEdge=7.5;
  const rightEdge=94.0;

  if(meta.kind==="f" && meta.value!==null){
    const n=Math.max(.01,Math.min(.30,meta.value));
    return line + (n/.30)*(rightEdge-line);
  }

  if(meta.kind==="normal" && meta.value!==null){
    const n=Math.max(0,Math.min(.99,meta.value));
    return line - (n/.99)*(line-leftEdge);
  }

  if(meta.kind==="l") return leftEdge;
  return null;
}

/*
  1枚目の参考デザインを基にした、背景透過の立体ボート素材。
  index.htmlだけで更新できるよう画像はファイル内へ埋め込む。
*/
const raceVisualBoatAssets={
  1:"assets/icons/bdfb51e020e584b5c817.png",
  2:"assets/icons/a9f085625832c78ad25f.png",
  3:"assets/icons/620162fd5ff7d4091219.png",
  4:"assets/icons/8cc4037f7a2cfb78af19.png",
  5:"assets/icons/e30cefb5e6f9163a5f28.png",
  6:"assets/icons/3623f93f39d762897018.png"
};



function raceVisualBoatSvg(lane){
  lane=Number(lane)||1;
  return `<img class="raceBoatImg" src="${raceVisualBoatAssets[lane]}" alt="" aria-hidden="true" draggable="false">`;
}

function raceVisualScaleMarks(){
  return [".99",".50",".20",".10","0.00","F.10","F.20","F.30"].map(label=>`<span class="raceScaleMark ${label==="0.00"?"zero":""}" style="left:${raceVisualPosition(label)}%">${label}</span>`).join("");
}

function renderRaceWaterVisual(items,{mode="start",title=""}={}){
  const list=[...(items||[])];
  const haveCourses=list.every(x=>Number(x.course)>=1&&Number(x.course)<=6);

  // スタート展示・本番ともに「実際の進入コース順」で上から並べる。
  if(haveCourses) list.sort((a,b)=>Number(a.course)-Number(b.course));
  else list.sort((a,b)=>Number(a.lane)-Number(b.lane));

  return `<div class="raceVisualCard ${mode==="result"?"isResult":"isStart"}">
    <div class="raceVisualRows">
      ${list.map(x=>{
        const lane=Number(x.lane)||1;
        const meta=raceVisualSTMeta(x.st);
        const bowPos=raceVisualPosition(x.st);

        const winnerMove=(mode==="result" && String(x.rank)==="1" && x.move)
          ? `<span class="raceVisualMove">${esc(x.move)}</span>`
          : "";

        return `<div class="raceVisualRow">
          <div class="raceVisualLane lane${lane}"
               style="background:${raceVisualLaneColor(lane)};color:${raceVisualTextColor(lane)}">
            <strong>${lane}</strong>
          </div>

          <div class="raceVisualWater">
            <span class="raceVisualFZone"></span>
            <span class="raceVisualZeroLine"></span>

            ${bowPos!==null?`<span class="raceWake" style="left:${bowPos}%"></span>`:""}

            <!-- left の位置＝舟の先端位置 -->
            ${bowPos!==null?`<span class="raceVisualBoat" style="left:${bowPos}%">${raceVisualBoatSvg(lane)}</span>`:`<span class="raceVisualUnavailable">${mode==="result"?"本番ST未取得":"展示ST未取得"}</span>`}

            ${winnerMove}

            <span class="raceVisualST ${meta.kind==="f"?"flying":meta.kind==="l"?"late":""}">
              ${meta.label}
            </span>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function renderStartSlit(boats,data){
  const stVals=boats.map((b,i)=>beforeMetric(data[i],b,"st"));
  const avgVals=boats.map(b=>firstStat(b,["stats.st.meet","st.meet","meetAvgST","avgST"]));

  const items=boats.map((b,i)=>({
    lane:Number(b.lane)||i+1,
    course:beforeMetric(data[i],b,"course"),
    st:stVals[i],
  }));

  const ranks=stVals.map(v=>{
    const meta=raceVisualSTMeta(v);
    if(meta.kind!=="normal" || meta.value===null) return null;
    const valid=stVals
      .map((x,idx)=>({idx,meta:raceVisualSTMeta(x)}))
      .filter(x=>x.meta.kind==="normal"&&x.meta.value!==null)
      .sort((a,b)=>a.meta.value-b.meta.value);
    const found=valid.findIndex(x=>x.meta.value===meta.value);
    return found>=0?found+1:null;
  });

  return `<div class="startSlitPanel proStartVisual">
    ${renderRaceWaterVisual(items,{mode:"start",title:"スタート展示"})}

    <div class="startVisualMeta">
      <div class="startVisualMetaHead">
        <span>枠</span><span>今節平均ST</span><span>展示ST順位</span>
      </div>
      ${boats.map((b,i)=>`
        <div class="startVisualMetaRow">
          <span>${beforeCourseChip(b.lane)}</span>
          <strong>${beforeFmt(avgVals[i],2)}</strong>
          <b>${ranks[i]||"--"}</b>
        </div>
      `).join("")}
    </div>
  </div>`;
}

function setBeforeSubTab(tab){
  beforeSubTab=tab;
  const body=document.getElementById("beforeInnerPanel");
  if(body) body.innerHTML=renderBeforeInner();
  document.querySelectorAll(".beforeSubTabs button").forEach(
    b=>b.classList.toggle("active",b.dataset.beforeTab===tab)
  );
}

function renderBeforeInner(){
  const r=state.currentRace||{};
  const boats=(r.boats||[]).slice(0,6);
  if(!boats.length) return `<p class="dataPlaceholder">出走選手データを取得中です。</p>`;
  const data=boats.map(b=>beforeDataForBoat(b,r));

  if(beforeSubTab==="start"){
    return `<div class="beforeSectionBlock beforeProConnected">
        ${beforeRacerHeader(boats)}
        <div class="beforeSubSectionTitle">スタート展示</div>
        ${renderStartSlit(boats,data)}
      </div>
      ${renderWeatherPanel(r)}`;
  }

  if(beforeSubTab==="original"){
    return `<div class="beforeSectionBlock beforeProConnected">
        ${beforeRacerHeader(boats)}
        <div class="beforeSubSectionTitle">オリジナル展示データ
          <span class="beforeHighlightLegend"><i></i>1位 <i></i>2位</span>
        </div>
        ${renderOriginalExhibition(boats,data)}
      </div>`;
  }

  return `<div class="beforeSectionBlock beforeProConnected">
      ${beforeRacerHeader(boats)}
      <div class="beforeSubSectionTitle">直前情報</div>
      ${beforeTable(boats,data)}
    </div>`;
}

function renderBeforeInfo(){
  const stamp=state.currentRace?.beforeUpdatedAt;
  return `<div class="beforeInfoPage">
    <div class="beforePageTitle">
      <div>
        <h3>直前情報</h3>
        <p>展示・スタート・水面状況をレース直前に確認</p>
      </div>
      <span>${stamp?`最終取得 ${esc(formatUpdated(stamp).replace(" 更新",""))}`:"公開・更新待ち"}</span>
    </div>

    <div class="beforeSubTabs">
      <button data-before-tab="info" class="${beforeSubTab==="info"?"active":""}" onclick="setBeforeSubTab('info')">直前情報</button>
      <button data-before-tab="start" class="${beforeSubTab==="start"?"active":""}" onclick="setBeforeSubTab('start')">スタート展示</button>
      <button data-before-tab="original" class="${beforeSubTab==="original"?"active":""}" onclick="setBeforeSubTab('original')">オリジナル展示データ</button>
    </div>

    <div id="beforeInnerPanel">${renderBeforeInner()}</div>
  </div>`;
}


function oddsPath(obj, keys){
  for(const key of keys){
    const parts=String(key).split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}

function oddsRoot(race){
  return race?.odds || race?.oddsData || race?.bettingOdds || {};
}

function normalizeOddsEntries(src){
  if(!src) return [];
  if(Array.isArray(src)){
    return src.map(x=>{
      if(Array.isArray(x)){
        return {combination:x[0],odds:x[1]};
      }
      return x;
    }).filter(Boolean);
  }
  if(typeof src==="object"){
    return Object.entries(src).map(([k,v])=>{
      if(v && typeof v==="object" && !Array.isArray(v)){
        return {combination:k,...v,odds:v.odds??v.value??v.rate};
      }
      return {combination:k,odds:v};
    });
  }
  return [];
}

function oddsEntriesFor(race,type){
  const root=oddsRoot(race);
  const aliases={
    trifecta:["trifecta","3t","sanrentan","tripleExacta","trifectaOdds"],
    trio:["trio","3f","sanrenpuku","tripleQuinella","trioOdds"],
    exacta:["exacta","2t","nirentan","exactaOdds"],
    quinella:["quinella","2f","nirenpuku","quinellaOdds"],
    wide:["wide","wakuren","kakurenpuku","wideOdds"],
    win:["win","tansho","single","winOdds"],
    place:["place","fukusho","placeOdds"]
  };
  for(const k of aliases[type]||[type]){
    const v=oddsPath(root,[k,`odds.${k}`,`data.${k}`]);
    if(v!==null) return normalizeOddsEntries(v);
  }
  return [];
}

function parseCombo(raw){
  if(raw===undefined||raw===null) return [];
  if(Array.isArray(raw)) return raw.map(Number).filter(n=>n>=1&&n<=6);
  const nums=String(raw).match(/[1-6]/g);
  return nums ? nums.map(Number) : [];
}

function oddsNumber(v){
  const n=parseRankableNumber(v);
  return n===null?null:n;
}

function oddsFmt(v){
  const n=oddsNumber(v);
  if(n===null) return "--";
  if(n>=1000) return n.toFixed(0);
  if(n>=100) return n.toFixed(1);
  return n.toFixed(1);
}

function oddsLaneChip(n){
  n=Number(n);
  if(!Number.isFinite(n)||n<1||n>6) return `<span class="oddsChip empty">--</span>`;
  return `<span class="oddsChip lane${n}">${n}</span>`;
}

function oddsComboHtml(combo,sep="-"){
  const nums=parseCombo(combo);
  if(!nums.length) return "--";
  return nums.map(oddsLaneChip).join(`<span class="oddsSep">${sep}</span>`);
}

function oddsRacerName(lane){
  const boat=(state.currentRace?.boats||[]).find(b=>Number(b.lane||b.boatNo||b.frame)===Number(lane));
  return cleanRacerName(boat?.racerName||boat?.name||"")||"--";
}
function oddsComboNames(combo){
  const nums=parseCombo(combo);
  return nums.length?nums.map(oddsRacerName).join("・"):"--";
}
function renderOddsRacerLegend(){
  return `<div class="oddsRacerLegend">${[1,2,3,4,5,6].map(lane=>`
    <div><span>${oddsLaneChip(lane)}</span><b>${esc(oddsRacerName(lane))}</b></div>`).join("")}</div>`;
}

function sortOdds(entries,mode){
  const arr=[...entries];
  if(mode==="popular"){
    arr.sort((a,b)=>{
      const ao=oddsNumber(a.odds??a.value??a.rate);
      const bo=oddsNumber(b.odds??b.value??b.rate);
      if(ao===null && bo===null)return 0;
      if(ao===null)return 1;
      if(bo===null)return -1;
      return ao-bo;
    });
  }else if(mode==="high"){
    arr.sort((a,b)=>{
      const ao=oddsNumber(a.odds??a.value??a.rate);
      const bo=oddsNumber(b.odds??b.value??b.rate);
      if(ao===null && bo===null)return 0;
      if(ao===null)return 1;
      if(bo===null)return -1;
      return bo-ao;
    });
  }
  return arr;
}

function oddsDisplayStamp(){
 const r=state.currentRace||{},keys=oddsSubTab==="pair"?["exacta","quinella"]:oddsSubTab==="winplace"?["win","place"]:[oddsSubTab];
 if(keys.some(k=>!r.odds?.[k]?.length))return "未取得・更新待ち";
 const stamps=keys.filter(k=>r.odds?.[k]?.length).map(k=>r.odds?.updatedAtByType?.[k]||r.oddsUpdatedAt).filter(Boolean).sort();
 if(!stamps.length)return "未取得・更新待ち";
 const oldest=new Date(stamps[0]);
 const age=(Date.now()-oldest.getTime())/60000;
 const mins=minutesUntil(r.deadline);
 const limit=mins!==null&&mins<=30?6:mins!==null&&mins<=120?10:25;
 if(!Number.isFinite(age)||age>limit)return `更新待ち（最終 ${formatUpdated(stamps[0])}）`;
 return `最終更新 ${formatUpdated(stamps[0]).replace(" 更新","")}`;
}
function setOddsSubTab(tab){
  oddsSubTab=tab;
  const stamp=document.getElementById("oddsFetchedAt");if(stamp)stamp.textContent=oddsDisplayStamp();
  oddsSortMode="normal";
  const body=document.getElementById("oddsInnerPanel");
  if(body) body.innerHTML=renderOddsInner();
  document.querySelectorAll(".oddsSubTabs button").forEach(
    b=>b.classList.toggle("active",b.dataset.oddsTab===tab)
  );
}

function setOddsSort(mode){
  oddsSortMode=mode;
  const body=document.getElementById("oddsInnerPanel");
  if(body) body.innerHTML=renderOddsInner();
}

function oddsEmpty(text="オッズデータは未取得です"){
  return `<div class="oddsEmpty"><b>${text}</b><span>公開情報の取得後に自動反映します。</span></div>`;
}

function renderOddsTrifecta(entries){
  if(!entries.length) return oddsEmpty("3連単オッズは未取得です");

  const groups={1:[],2:[],3:[],4:[],5:[],6:[]};
  entries.forEach(e=>{
    const c=parseCombo(e.combination??e.combo??e.number);
    if(c.length>=3 && groups[c[0]]) groups[c[0]].push({...e,_combo:c});
  });

  Object.values(groups).forEach(g=>g.sort((a,b)=>{
    const ac=a._combo,bc=b._combo;
    return (ac[1]-bc[1]) || (ac[2]-bc[2]);
  }));

  return `<div class="oddsMainSection">
    <div class="oddsSectionBar">
      <b>3連単 オッズ</b>
      <div class="oddsSort">
        <button class="${oddsSortMode==="normal"?"active":""}" onclick="setOddsSort('normal')">通常</button>
        <button class="${oddsSortMode==="popular"?"active":""}" onclick="setOddsSort('popular')">人気順</button>
      </div>
    </div>
    ${oddsSortMode==="normal"
      ? `<div class="oddsTrifectaGrid">
          ${[1,2,3,4,5,6].map(first=>`
            <div class="oddsFirstCard">
              <div class="oddsFirstHead laneHead${first}"><span>1着</span><b>${first}</b><strong>${esc(oddsRacerName(first))}</strong></div>
              <div class="oddsFirstTable">
                <div class="oddsFirstTableHead"><span>2着</span><span>3着</span><span>オッズ</span></div>
                ${(groups[first]||[]).map(e=>`
                  <div class="oddsFirstRow">
                    <div>${oddsLaneChip(e._combo[1])}</div>
                    <div>${oddsLaneChip(e._combo[2])}</div>
                    <div>${oddsFmt(e.odds??e.value??e.rate)}</div>
                  </div>`).join("") || `<div class="oddsMiniEmpty">--</div>`}
              </div>
            </div>`).join("")}
        </div>`
      : renderOddsRankList(sortOdds(entries,"popular"),"人気順",10)
    }
    ${renderOddsBestPanels(entries)}
  </div>`;
}

function renderOddsRankList(entries,title,limit=10){
  const arr=entries.slice(0,limit);
  return `<div class="oddsRankBox">
    <div class="oddsRankTitle">${title}</div>
    <div class="oddsRankHead"><span>順位</span><span>組番</span><span>オッズ</span></div>
    ${arr.map((e,i)=>`
      <div class="oddsRankRow">
        <span>${i+1}</span>
        <div>${oddsComboHtml(e.combination??e.combo??e.number)}</div>
        <b>${oddsFmt(e.odds??e.value??e.rate)}</b>
      </div>`).join("") || `<div class="oddsMiniEmpty">--</div>`}
  </div>`;
}

function renderOddsBestPanels(entries){
  if(!entries.length)return "";
  return `<div class="oddsBestGrid">
    ${renderOddsRankList(sortOdds(entries,"popular"),"👑 人気順ベスト10",10)}
    ${renderOddsRankList(sortOdds(entries,"high"),"🎯 高配当ベスト10",10)}
  </div>`;
}

function renderOddsSimple(entries,title,comboLen=2){
  if(!entries.length) return oddsEmpty(`${title}は未取得です`);
  const sorted=sortOdds(entries,oddsSortMode==="popular"?"popular":"normal");
  return `<div class="oddsMainSection">
    <div class="oddsSectionBar">
      <b>${title}</b>
      <div class="oddsSort">
        <button class="${oddsSortMode==="normal"?"active":""}" onclick="setOddsSort('normal')">通常</button>
        <button class="${oddsSortMode==="popular"?"active":""}" onclick="setOddsSort('popular')">人気順</button>
      </div>
    </div>
    <div class="oddsSimpleTable">
      <div class="oddsSimpleHead"><span>組番</span><span>オッズ</span></div>
      ${sorted.map(e=>`
        <div class="oddsSimpleRow">
          <div class="oddsComboWithNames"><span>${oddsComboHtml(e.combination??e.combo??e.number)}</span><small>${esc(oddsComboNames(e.combination??e.combo??e.number))}</small></div>
          <b>${oddsFmt(e.odds??e.value??e.rate)}</b>
        </div>`).join("")}
    </div>
  </div>`;
}

function renderOddsPairGroup(exacta,quinella){
  return `<div class="oddsDualGrid">
    <div>${renderOddsSimple(exacta,"2連単")}</div>
    <div>${renderOddsSimple(quinella,"2連複")}</div>
  </div>`;
}

function renderOddsWinPlace(win,place){
  const rows=[1,2,3,4,5,6].map(lane=>{
    const w=win.find(e=>parseCombo(e.combination??e.combo??e.number)[0]===lane);
    const p=place.find(e=>parseCombo(e.combination??e.combo??e.number)[0]===lane);
    const pv=p?.odds??p?.value??p?.rate;
    let placeText="--";
    if(Array.isArray(pv)) placeText=pv.map(oddsFmt).join(" - ");
    else if(p?.min!==undefined || p?.max!==undefined) placeText=`${oddsFmt(p.min)} - ${oddsFmt(p.max)}`;
    else if(typeof pv==="string" && /[-〜~]/.test(pv)) placeText=esc(pv);
    else if(pv!==undefined) placeText=oddsFmt(pv);
    return `<div class="oddsWPRow">
      <div>${oddsLaneChip(lane)}</div>
      <strong>${esc(oddsRacerName(lane))}</strong>
      <b>${w?oddsFmt(w.odds??w.value??w.rate):"--"}</b>
      <b>${placeText}</b>
    </div>`;
  }).join("");
  return `<div class="oddsMainSection">
    <div class="oddsSectionBar"><b>単勝・複勝</b></div>
    <div class="oddsWPTable">
      <div class="oddsWPHead"><span>C</span><span>名称</span><span>単勝</span><span>複勝</span></div>
      ${rows}
    </div>
  </div>`;
}

function renderOddsInner(){
  const r=state.currentRace||{};
  if(oddsSubTab==="trifecta") return renderOddsTrifecta(oddsEntriesFor(r,"trifecta"));
  if(oddsSubTab==="trio") return renderOddsSimple(oddsEntriesFor(r,"trio"),"3連複");
  if(oddsSubTab==="pair") return renderOddsPairGroup(oddsEntriesFor(r,"exacta"),oddsEntriesFor(r,"quinella"));
  if(oddsSubTab==="wide") return renderOddsSimple(oddsEntriesFor(r,"wide"),"拡連複");
  return renderOddsWinPlace(oddsEntriesFor(r,"win"),oddsEntriesFor(r,"place"));
}

function renderOddsInfo(){
  const r=state.currentRace||{};
  return `<div class="oddsInfoPage">
    <div class="oddsPageTitle">
      <div>
        <h3>オッズ</h3>
        <p>舟券種別ごとにオッズを見やすく比較</p>
      </div>
      <span>未取得は --</span>
    </div>

    <div class="oddsRaceStatus">
      <div><b>${r.raceNo||"--"}R</b><span>${meetingGrade(state.currentMeeting||{})}</span><strong>締切 ${esc(r.deadline||"--:--")}</strong></div>
      <small>オッズ取得 <span id="oddsFetchedAt">${esc(oddsDisplayStamp())}</span></small>
    </div>

    ${renderOddsRacerLegend()}

    <div class="oddsSubTabs">
      <button data-odds-tab="trifecta" class="${oddsSubTab==="trifecta"?"active":""}" onclick="setOddsSubTab('trifecta')">3連単</button>
      <button data-odds-tab="trio" class="${oddsSubTab==="trio"?"active":""}" onclick="setOddsSubTab('trio')">3連複</button>
      <button data-odds-tab="pair" class="${oddsSubTab==="pair"?"active":""}" onclick="setOddsSubTab('pair')">2連単・2連複</button>
      <button data-odds-tab="wide" class="${oddsSubTab==="wide"?"active":""}" onclick="setOddsSubTab('wide')">拡連複</button>
      <button data-odds-tab="winplace" class="${oddsSubTab==="winplace"?"active":""}" onclick="setOddsSubTab('winplace')">単勝・複勝</button>
    </div>

    <div id="oddsInnerPanel">${renderOddsInner()}</div>

    <div class="oddsNote">※ オッズは主催者発表のものと照合してください。</div>
  </div>`;
}


function resultPath(obj, keys){
  for(const key of keys){
    const parts=String(key).split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}

function resultRoot(race){
  return race?.result || race?.raceResult || race?.results || {};
}

function resultEntries(race){
  const root=resultRoot(race);
  const sources=[
    root?.finishers,root?.order,root?.entries,root?.racers,root?.boats,
    race?.finishers,race?.resultEntries
  ];
  for(const s of sources){
    if(Array.isArray(s)) return s;
  }
  if(Array.isArray(root)) return root;
  return [];
}

function resultEntryValue(item, keys){
  return resultPath(item,keys);
}

function resultRankText(v){
  if(v===undefined||v===null||v==="") return "--";
  const s=String(v).trim();
  if(/^F$/i.test(s)) return "F";
  if(/^L$/i.test(s)) return "L";
  if(/^[1-6]$/.test(s)) return s;
  const n=parseInt(s,10);
  return Number.isFinite(n)?String(n):esc(s);
}

function resultTime(v){
  if(v===undefined||v===null||v==="") return "--";
  return esc(String(v));
}

function resultST(v){
  if(v===undefined||v===null||v==="") return "--";
  const s=String(v).trim();
  if(/^F/i.test(s)) return `<span class="resultSTFlag">${esc(s)}</span>`;
  const n=Number(s);
  if(Number.isFinite(n)) return n.toFixed(2).replace(/^0/,"");
  return esc(s);
}

function resultBoatVisual(lane, move=""){
  lane=Number(lane)||1;
  return `<div class="resultBoatVisual lane${lane}">
    <span class="resultBoatHull"></span>
    <span class="resultBoatDriver"></span>
    ${move?`<em>${esc(move)}</em>`:""}
  </div>`;
}

function resultStartVisualItems(race){
  const boats=(race?.boats||[]).slice(0,6);
  const root=resultRoot(race);
  const starts=root?.startEntries||root?.startInfo||race?.startEntries||[];
  const byLane=new Map();
  (Array.isArray(starts)?starts:[]).forEach((x,i)=>{
    const lane=Number(x?.lane||x?.boatNo||x?.frame||x?.number);
    if(lane>=1&&lane<=6)byLane.set(lane,{lane,course:Number(x?.course||x?.entryCourse||x?.actualCourse||x?.courseNo)||null,st:x?.st??x?.startTiming??x?.start});
  });
  const entries=resultEntries(race);
  entries.forEach((x,i)=>{
    const lane=Number(resultEntryValue(x,["lane","boatNo","frame","waku","number"]))||i+1;
    const prev=byLane.get(lane)||{lane};
    prev.course=prev.course||Number(resultEntryValue(x,["course","entry","courseNo","entryCourse","actualCourse","startCourse"]))||null;
    prev.st=prev.st??resultEntryValue(x,["st","startTiming","start"]);
    prev.rank=resultEntryValue(x,["rank","finish","arrival","place","finishPlace"]);
    prev.move=prev.move??resultEntryValue(x,["kimarite","winningMove","decision","move"]);
    byLane.set(lane,prev);
  });
  boats.forEach(b=>{
    const lane=Number(b.lane)||1;
    const prev=byLane.get(lane)||{lane};
    prev.course=prev.course||Number(firstStat(b,["result.course","result.entry","result.entryCourse"]))||null;
    prev.st=prev.st??firstStat(b,["result.st","result.startTiming"]);
    prev.rank=prev.rank??firstStat(b,["result.rank","result.finish","finish","rank"]);
    prev.move=prev.move??firstStat(b,["result.kimarite","result.winningMove","kimarite"]);
    byLane.set(lane,prev);
  });
  const winnerMove=resultPath(root,["kimarite","winningMove","decision","move"])||"";
  return [...byLane.values()].filter(x=>x.lane>=1&&x.lane<=6).map(x=>{if(String(x.rank)==="1"&&!x.move)x.move=winnerMove;return x;});
}
function resultFinishRows(race){
  const boats=(race?.boats||[]).slice(0,6);
  const entries=resultEntries(race);
  const normalized=[];
  if(entries.length){
    entries.forEach((x,i)=>{
      const lane=Number(resultEntryValue(x,["lane","boatNo","frame","waku","number"]))||Number(x?.lane)||i+1;
      const rank=resultEntryValue(x,["rank","finish","arrival","place","finishPlace"]);
      const racerName=resultEntryValue(x,["racerName","name","playerName"])||boats.find(b=>Number(b.lane)===lane)?.racerName||"--";
      const time=resultEntryValue(x,["time","raceTime","finishTime"]);
      const st=resultEntryValue(x,["st","startTiming","start"]);
      normalized.push({lane,rank,racerName,time,st});
    });
  }else{
    boats.forEach(b=>{
      const lane=Number(b.lane)||1;
      normalized.push({lane,rank:firstStat(b,["result.rank","result.finish","finish","rank"]),racerName:b.racerName||"--",time:firstStat(b,["result.time","raceTime","finishTime"]),st:firstStat(b,["result.st","result.startTiming"])});
    });
  }
  normalized.sort((a,b)=>{
    const ar=/^[1-6]$/.test(String(a.rank||""))?Number(a.rank):99;
    const br=/^[1-6]$/.test(String(b.rank||""))?Number(b.rank):99;
    return ar-br;
  });
  return normalized.map(x=>{
    const rank=resultRankText(x.rank),isWinner=rank==="1",isSecond=rank==="2";
    const rankClass=isWinner?"resultWinner":isSecond?"resultSecond":"";
    return `<div class="resultFinishRow ${rankClass}"><div class="resultFinishRank">${rank}</div><div>${oddsLaneChip(x.lane)}</div><div class="resultRacerName">${formatRacerNameTwoLines(cleanRacerName(x.racerName)||"--")}</div><div class="resultTime">${resultTime(x.time)}</div><div class="resultST">${resultST(x.st)}</div></div>`;
  }).join("");
}

function payoutSources(race){
  const root=resultRoot(race);
  return root?.payouts || root?.refunds || race?.payouts || race?.refunds || {};
}

function payoutValue(root, keys){
  return resultPath(root,keys);
}

function normalizePayoutCombos(v){
  if(v===undefined||v===null||v==="") return [];
  if(Array.isArray(v)){
    return v.map(x=>{
      if(typeof x==="object") return {
        combination:x.combination??x.combo??x.number??x.bet,
        payout:x.payout??x.amount??x.value
      };
      return {combination:x,payout:null};
    });
  }
  if(typeof v==="object"){
    return Object.entries(v).map(([k,val])=>{
      if(val && typeof val==="object") return {combination:k,payout:val.payout??val.amount??val.value};
      return {combination:k,payout:val};
    });
  }
  return [{combination:v,payout:null}];
}

function payoutRow(label, combos){
  const arr=normalizePayoutCombos(combos);
  if(!arr.length){
    return `<div class="resultPayoutRow">
      <div class="resultPayoutLabel">${label}</div>
      <div class="resultPayoutCombo">--</div>
      <div class="resultPayoutAmount">--</div>
    </div>`;
  }
  return arr.map((x,i)=>`<div class="resultPayoutRow">
    ${i===0?`<div class="resultPayoutLabel" style="grid-row:span ${arr.length}">${label}</div>`:""}
    <div class="resultPayoutCombo">${oddsComboHtml(x.combination??"",String(label).includes("複")?"=":"-")}</div>
    <div class="resultPayoutAmount">${x.payout!==undefined&&x.payout!==null&&x.payout!==""?`${esc(x.payout)}円`:"--"}</div>
  </div>`).join("");
}

function renderPayouts(race){
  const p=payoutSources(race);
  const defs=[
    ["2連勝単式",payoutValue(p,["exacta","2t","nirentan"])],
    ["2連勝複式",payoutValue(p,["quinella","2f","nirenpuku"])],
    ["3連勝単式",payoutValue(p,["trifecta","3t","sanrentan"])],
    ["3連勝複式",payoutValue(p,["trio","3f","sanrenpuku"])],
    ["拡大2連勝複式",payoutValue(p,["wide","wakuren","kakurenpuku"])],
    ["単勝式",payoutValue(p,["win","tansho"])],
    ["複勝式",payoutValue(p,["place","fukusho"])]
  ];

  const refund=resultPath(resultRoot(race),["refund","returnedBoat","return","refundBoat"]);
  const note=resultPath(resultRoot(race),["note","remarks","remark"]);

  return `<div class="resultPayoutTable">
    ${defs.map(([label,val])=>payoutRow(label,val)).join("")}
    ${refund!==null?`<div class="resultExtraRow"><span>返還</span><b>${oddsComboHtml(refund)}</b></div>`:""}
  </div>`;
}

function resultWeather(race){
  const root=resultRoot(race);
  const w=root?.weather || race?.weather || race?.weatherData || race?.conditions || {};
  return {
    weather:resultPath(w,["weather","condition","sky"]) ?? firstStat(race,["weatherName","weather.condition"]),
    windDir:resultPath(w,["windDirection","windDir","direction"]) ?? firstStat(race,["windDirection","weather.windDirection"]),
    windSpeed:resultPath(w,["windSpeed","wind","speed"]) ?? firstStat(race,["windSpeed","weather.windSpeed"]),
    wave:resultPath(w,["waveHeight","wave","waves"]) ?? firstStat(race,["waveHeight","weather.waveHeight"]),
    air:resultPath(w,["airTemperature","temperature","airTemp"]) ?? firstStat(race,["temperature","airTemperature"]),
    water:resultPath(w,["waterTemperature","waterTemp"]) ?? firstStat(race,["waterTemperature"])
  };
}

function renderResultWeather(race){
  const w=resultWeather(race);
  const f=(v,suffix="")=>v===undefined||v===null||v===""?"--":`${esc(v)}${suffix}`;
  return `<div class="resultWeatherTable">
    <div><small>天候</small><strong>${w.weather?esc(w.weather):"--"}</strong></div>
    <div><small>風向</small><strong>${w.windDir?esc(w.windDir):"--"}</strong></div>
    <div><small>風速</small><strong>${f(w.windSpeed,"m")}</strong></div>
    <div><small>波高</small><strong>${f(w.wave,"cm")}</strong></div>
    <div><small>気温</small><strong>${f(w.air,"℃")}</strong></div>
    <div><small>水温</small><strong>${f(w.water,"℃")}</strong></div>
  </div>`;
}

function renderResultInfo(){
  const r=state.currentRace||{};
  const root=resultRoot(r);
  const hasResult=resultEntries(r).length>0;
  return `<div class="resultInfoPage">
    <div class="resultPageTitle"><div><h3>結果</h3><p>競争成績・払戻金・気象状況</p></div><span>${r.resultUpdatedAt?`最終取得 ${esc(formatUpdated(r.resultUpdatedAt).replace(" 更新",""))}`:hasResult?"本番結果（取得時刻不明）":"本番結果の公開・更新待ち"}</span></div>
    <div class="resultRaceStatus"><div><b>${r.raceNo||"--"}R</b><strong>${esc(r.title||"レース結果")}</strong></div><small>締切 ${esc(r.deadline||"--:--")}</small></div>
    <div class="resultConnectedFrame">
      <div class="resultSectionBar">競争成績</div>
      <div class="resultVisualFull">${renderRaceWaterVisual(resultStartVisualItems(r),{mode:"result",title:"本番スタート"})}</div>
      <div class="resultFinishTable">
        <div class="resultFinishHead"><div>着</div><div>枠</div><div>選手名</div><div>タイム</div><div>ST</div></div>
        ${resultFinishRows(r)}
      </div>
      <div class="resultSectionBar">払戻金</div>${renderPayouts(r)}
      <div class="resultSectionBar">気象状況</div>${renderResultWeather(r)}
    </div>
    <div class="resultNote">※ 結果・払戻金は主催者発表のものと照合してください。</div>
  </div>`;
}

function replayPath(obj, keys){
  for(const key of keys){
    const parts=String(key).split(".");
    let v=obj;
    for(const p of parts){
      if(v===undefined || v===null) break;
      v=v[p];
    }
    if(v!==undefined && v!==null && v!=="") return v;
  }
  return null;
}

function replayRoot(race){
  return race?.replay || race?.replays || race?.video || race?.videos || {};
}

function normalizeVideoUrl(v){
  if(!v) return "";
  const s=String(v).trim();
  if(!s) return "";
  let m=s.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if(m) return `https://www.youtube.com/embed/${m[1]}`;
  m=s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  if(m) return `https://www.youtube.com/embed/${m[1]}`;
  if(/^https?:\/\//i.test(s)) return s;
  if(/^[A-Za-z0-9_-]{6,}$/.test(s)) return `https://www.youtube.com/embed/${s}`;
  return "";
}

function replayUrls(race){
  const root=replayRoot(race);
  const officialRacePage =
    replayPath(root,["racePage","officialPage","page","official"]) ??
    firstStat(race,["officialReplayPage","replay.officialPage"]);
  const officialExhibitionPage =
    replayPath(root,["exhibitionPage","officialExhibitionPage"]) ??
    (officialRacePage?`${String(officialRacePage).replace(/([?&])md=[^&]*/,"$1md=T")}${String(officialRacePage).includes("md=")?"":"&md=T"}`:"");
  const raceReplay =
    replayPath(root,["race","raceReplay","raceVideo","resultReplay","replay","race.url","raceReplay.url","videos.race"]) ??
    firstStat(race,["raceReplayUrl","replayUrl","raceVideoUrl","video.race","replay.race"]);
  const exhibitionReplay =
    replayPath(root,["exhibition","exhibitionReplay","startExhibition","exhibitionVideo","startExhibitionVideo","exhibition.url","videos.exhibition"]) ??
    firstStat(race,["exhibitionReplayUrl","startExhibitionReplayUrl","exhibitionVideoUrl","video.exhibition","replay.exhibition"]);
  return {
    race: normalizeVideoUrl(raceReplay),
    exhibition: normalizeVideoUrl(exhibitionReplay),
    raceRaw: raceReplay || "",
    exhibitionRaw: exhibitionReplay || "",
    officialRacePage: normalizeVideoUrl(officialRacePage),
    officialExhibitionPage: normalizeVideoUrl(officialExhibitionPage)
  };
}

function externalVideoUrl(embedUrl, rawUrl){
  if(rawUrl && /^https?:\/\//i.test(String(rawUrl))) return String(rawUrl);
  const m=String(embedUrl||"").match(/youtube\.com\/embed\/([A-Za-z0-9_-]+)/);
  if(m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return embedUrl || "";
}

function renderReplayVideo(title, embedUrl, rawUrl, officialPage=""){
  const external=externalVideoUrl(embedUrl,rawUrl);
  if(!embedUrl){
    return `<div class="replaySection">
      <div class="replaySectionHead">
        <div><span class="replayAccent"></span><b>${title}</b></div>
      </div>
      <div class="replayEmpty">
        <strong>${officialPage?`${title}を公式動画で再生`:`${title}はまだ取得されていません`}</strong>
        <span>${officialPage?"公式配信ページで動画を確認できます。":"公式動画URL取得後にここへ直接表示します。"}</span>
        ${officialPage?`<a class="replayOfficialButton" href="${esc(officialPage)}" target="_blank" rel="noopener">▶ ${title}を見る</a>`:""}
      </div>
    </div>`;
  }
  return `<div class="replaySection">
    <div class="replaySectionHead">
      <div><span class="replayAccent"></span><b>${title}</b></div>
      ${external?`<a href="${esc(external)}" target="_blank" rel="noopener">別画面で開く ↗</a>`:""}
    </div>
    <div class="replayVideoFrame">
      <iframe
        src="${esc(embedUrl)}"
        title="${title}"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin">
      </iframe>
    </div>
  </div>`;
}

function adjacentRaceNo(delta){
  const m=state.currentMeetingView||state.currentMeeting||{};
  const races=(m.races||[]).map(r=>Number(r.raceNo)).filter(Number.isFinite).sort((a,b)=>a-b);
  const current=Number(state.currentRace?.raceNo);
  if(!current || !races.length) return null;
  const idx=races.indexOf(current);
  if(idx<0) return null;
  const target=races[idx+delta];
  return Number.isFinite(target)?target:null;
}

function replayRaceNav(){
  const prev=adjacentRaceNo(-1);
  const next=adjacentRaceNo(1);
  return `<div class="replayRaceNav">
    <button ${prev?"":'disabled'} onclick="${prev?`openRace(${prev})`:""}">
      <span>‹</span>${prev?`${prev}R 前のレース`:"前のレースなし"}
    </button>
    <button ${next?"":'disabled'} onclick="${next?`openRace(${next})`:""}">
      ${next?`次のレース ${next}R`:"次のレースなし"}<span>›</span>
    </button>
  </div>`;
}

function renderReplayInfo(){
  const r=state.currentRace||{};
  const urls=replayUrls(r);
  return `<div class="replayInfoPage">
    <div class="replayPageTitle">
      <div>
        <h3>リプレイ</h3>
        <p>レース動画・展示動画をこのページで直接再生</p>
      </div>
      <span>OFFICIAL VIDEO</span>
    </div>

    <div class="replayRaceStatus">
      <div>
        <b>${r.raceNo||"--"}R</b>
        <strong>${esc(r.title||"レース")}</strong>
      </div>
      <small>締切 ${esc(r.deadline||"--:--")}</small>
    </div>

    ${renderReplayVideo("レースリプレイ",urls.race,urls.raceRaw,urls.officialRacePage)}
    ${renderReplayVideo("展示リプレイ",urls.exhibition,urls.exhibitionRaw,urls.officialExhibitionPage)}

    <div class="replayNotice">
      <b>ご注意</b>
      <span>動画は公式配信元の埋め込み再生に対応しています。</span>
      <span>配信元の設定により、サイト内再生できない動画は別画面で開く必要があります。</span>
      <span>通信環境によって再生開始まで時間がかかる場合があります。</span>
    </div>

    ${replayRaceNav()}
  </div>`;
}


function demoSavePoints(){
  localStorage.setItem("boatCheckDemoPoints",String(Math.max(0,Math.floor(demoPoints))));
  renderHomePointBalance();
}
function demoFormatPt(v){
  return `${Number(v||0).toLocaleString("ja-JP")}pt`;
}
function demoBetLabel(type){
  return {
    trifecta:"3連単",trio:"3連複",exacta:"2連単",quinella:"2連複",
    wide:"拡連複",win:"単勝",place:"複勝"
  }[type]||type;
}
function demoSelectionCount(type){
  return ["trifecta","trio"].includes(type)?3:["exacta","quinella","wide"].includes(type)?2:1;
}
function demoAllowedMethods(type){
  return demoSelectionCount(type)>=2 ? ["normal","box","formation"] : ["normal"];
}
function demoMethodLabel(method){
  return {normal:"通常",box:"ボックス",formation:"フォーメーション"}[method]||method;
}
function demoResetSelection(){
  demoSelections={first:[],second:[],third:[]};
}
function setDemoMainTab(tab){
  demoMainTab=tab;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function setDemoBetType(type){
  demoBetType=type;
  if(!demoAllowedMethods(type).includes(demoMethod))demoMethod="normal";
  demoResetSelection();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function setDemoMethod(method){
  demoMethod=method;
  demoResetSelection();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoToggleLane(group,lane){
  lane=Number(lane);
  const arr=demoSelections[group]||[];
  const idx=arr.indexOf(lane);

  if(demoMethod==="normal"){
    demoSelections[group]=idx>=0?[]:[lane];
  }else{
    if(idx>=0)arr.splice(idx,1); else arr.push(lane);
    arr.sort((a,b)=>a-b);
    demoSelections[group]=arr;
  }

  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoSelectAll(group){
  if(demoMethod!=="formation")return;
  const current=demoSelections[group]||[];
  demoSelections[group]=current.length===6 ? [] : [1,2,3,4,5,6];
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}

function demoSelectionChip(lane){
  return oddsLaneChip(lane);
}

function demoRacerFL(boat){
  const f=firstStat(boat,[
    "flyingCount","fCount","F","f",
    "stats.flyingCount","stats.fCount",
    "accident.flyingCount","accident.fCount",
    "racerStats.flyingCount","racerStats.fCount"
  ]);
  const l=firstStat(boat,[
    "lateCount","lCount","L","l",
    "stats.lateCount","stats.lCount",
    "accident.lateCount","accident.lCount",
    "racerStats.lateCount","racerStats.lCount"
  ]);
  const fv=(f===undefined||f===null||f==="") ? "--" : esc(f);
  const lv=(l===undefined||l===null||l==="") ? "--" : esc(l);
  return `<span class="demoFL"><b>F${fv}</b><i>|</i><b>L${lv}</b></span>`;
}

function demoRacerHeader(){
  const boats=(state.currentRace?.boats||[]).slice(0,6);
  return `<div class="demoRacerStrip">
    ${boats.map(b=>`<div class="demoRacer laneBg${b.lane}">
      <span class="demoLane lane${b.lane}">${b.lane}</span>
      <strong>${formatRacerNameTwoLines(cleanRacerName(b.racerName)||"--")}</strong>
      <small>${esc(b.racerId||b.registrationNo||"----")}</small>
      <small>${esc(b.class||"--")} / ${b.period?esc(b.period)+"期":"--期"}</small>
      ${demoRacerFL(b)}
    </div>`).join("")}
  </div>`;
}
function demoLanePicker(group,label){
  const selected=demoSelections[group]||[];
  const showAll=demoMethod==="formation";
  const allSelected=selected.length===6;
  return `<div class="demoPickRow">
    <div class="demoPickLabel">${label}</div>
    <div class="demoPickButtons ${showAll?"hasAll":""}">
      ${[1,2,3,4,5,6].map(lane=>`
        <button type="button" class="demoLanePick lane${lane} ${selected.includes(lane)?"selected":""}"
          onclick="demoToggleLane('${group}',${lane})">
          <span class="demoLaneNumber">${lane}</span>
          ${selected.includes(lane)?'<span class="demoSelectedMark">選択中</span>':""}
        </button>`).join("")}
      ${showAll?`<button type="button" class="demoLanePick demoAllPick ${allSelected?"selected":""}"
        onclick="demoSelectAll('${group}')">
        <span class="demoLaneNumber">全</span>
        ${allSelected?'<span class="demoSelectedMark">全選択</span>':""}
      </button>`:""}
    </div>
  </div>`;
}
function demoBuildCombos(){
  const count=demoSelectionCount(demoBetType);
  const s1=[...demoSelections.first];
  const s2=[...demoSelections.second];
  const s3=[...demoSelections.third];
  const combos=[];

  if(count===1){
    s1.forEach(a=>combos.push([a]));
  }else if(demoMethod==="box"){
    const base=s1;
    if(demoBetType==="trifecta"){
      base.forEach(a=>base.forEach(b=>base.forEach(c=>{
        if(a!==b&&a!==c&&b!==c)combos.push([a,b,c]);
      })));
    }else if(demoBetType==="trio"){
      for(let i=0;i<base.length;i++)for(let j=i+1;j<base.length;j++)for(let k=j+1;k<base.length;k++)combos.push([base[i],base[j],base[k]]);
    }else if(["exacta"].includes(demoBetType)){
      base.forEach(a=>base.forEach(b=>{if(a!==b)combos.push([a,b]);}));
    }else{
      for(let i=0;i<base.length;i++)for(let j=i+1;j<base.length;j++)combos.push([base[i],base[j]]);
    }
  }else{
    if(count===2){
      s1.forEach(a=>s2.forEach(b=>{
        if(a===b)return;
        if(["quinella","wide"].includes(demoBetType)){
          const c=[a,b].sort((x,y)=>x-y);
          if(!combos.some(x=>x[0]===c[0]&&x[1]===c[1]))combos.push(c);
        }else combos.push([a,b]);
      }));
    }else{
      s1.forEach(a=>s2.forEach(b=>s3.forEach(c=>{
        if(a===b||a===c||b===c)return;
        if(demoBetType==="trio"){
          const combo=[a,b,c].sort((x,y)=>x-y);
          if(!combos.some(x=>x.join("-")===combo.join("-")))combos.push(combo);
        }else{
          combos.push([a,b,c]);
        }
      })));
    }
  }
  return combos;
}
function demoCurrentOdds(combo){
  const r=state.currentRace||{};
  const typeMap={
    trifecta:"trifecta",trio:"trio",exacta:"exacta",quinella:"quinella",
    wide:"wide",win:"win",place:"place"
  };
  const entries=oddsEntriesFor(r,typeMap[demoBetType]);
  const key=combo.join("-");
  const alt=[...combo].sort((a,b)=>a-b).join("-");
  const ordered=["trifecta","exacta"].includes(demoBetType);
  const found=entries.find(e=>{
    const c=parseCombo(e.combination??e.combo??e.number);
    if(!c.length)return false;
    return (ordered?c.join("-"):[...c].sort((a,b)=>a-b).join("-")) === (ordered?key:alt);
  });
  return found?oddsNumber(found.odds??found.value??found.rate):null;
}
function demoDeadlineClosed(date,deadline){
  const now=jstNow();
  const d=String(date||"");
  const dl=String(deadline||"");
  if(d && d<now.date)return true;
  if(d && d>now.date)return false;
  if(!dl)return false;
  return raceIsPast(dl,now.time);
}
function demoCurrentRaceClosed(){
  const r=state.currentRace||{};
  const m=state.currentMeetingView||state.currentMeeting||{};
  if(raceIsCancelled(r))return true;
  return demoDeadlineClosed(m.date||state.currentDayDate||"",r.deadline||"");
}
function demoCartItemClosed(item){
  if(!item)return false;
  const meeting=(state.meetings||[]).find(m=>String(m.venueCode||"")===String(item.venueCode||""));
  if(meeting){
    let races=[];
    if(String(meeting.date||"")===String(item.date||""))races=meeting.races||[];
    const day=(meeting.meetDays||[]).find(d=>String(d.date||"")===String(item.date||""));
    if(day?.races?.length)races=day.races;
    const race=races.find(r=>Number(r.raceNo)===Number(item.raceNo));
    if(race && raceIsCancelled(race))return true;
  }
  return demoDeadlineClosed(item.date||"",item.deadline||"");
}
function demoRequireOpenRace(){
  if(!demoCurrentRaceClosed())return true;
  demoBetModalOpen=false;
  demoDraftList=[];
  demoToast("締切済みのためデモ投票できません");
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
  return false;
}
function demoAddSelections(){
  if(!demoRequireOpenRace())return;
  const combos=demoBuildCombos();
  if(!combos.length)return;

  demoDraftList=combos.map(combo=>({
    key:`${demoBetType}:${combo.join("-")}`,
    type:demoBetType,
    combo:[...combo],
    odds:demoCurrentOdds(combo),
    stake:demoStake
  }));

  demoBetModalOpen=true;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}


function demoPersistCart(){
  localStorage.setItem("boatCheckDemoCart",JSON.stringify(demoCart));
}
function demoToast(message){
  let el=document.getElementById("demoToast");
  if(!el){
    el=document.createElement("div");
    el.id="demoToast";
    el.className="demoToast";
    document.body.appendChild(el);
  }
  el.textContent=message;
  el.classList.add("show");
  clearTimeout(window.__demoToastTimer);
  window.__demoToastTimer=setTimeout(()=>el.classList.remove("show"),1800);
}
function demoCurrentMeetingMeta(){
  const m=state.currentMeetingView||state.currentMeeting||{};
  return {
    venueCode:String(m.venueCode||state.currentMeeting?.venueCode||"").padStart(2,"0"),
    venueName:m.name||m.venueName||demoVenueLabel(),
    date:m.date||"",
    meetingTitle:m.title||m.eventTitle||""
  };
}
function demoDraftToCartItems(){
  const r=state.currentRace||{};
  const meta=demoCurrentMeetingMeta();
  return demoDraftList.map(x=>({
    ...x,
    venueCode:meta.venueCode,
    venueName:meta.venueName,
    date:meta.date,
    meetingTitle:meta.meetingTitle,
    raceNo:r.raceNo||"",
    deadline:r.deadline||"",
    cartKey:`${meta.venueCode}:${meta.date}:${r.raceNo||""}:${x.type}:${x.combo.join("-")}`
  }));
}
function demoMergeDraftToCart(){
  if(!demoRequireOpenRace())return false;
  const items=demoDraftToCartItems();
  items.forEach(item=>{
    const idx=demoCart.findIndex(x=>x.cartKey===item.cartKey);
    if(idx>=0) demoCart[idx]={...demoCart[idx],...item};
    else demoCart.push(item);
  });
  demoPersistCart();
  return true;
}
function demoSetCartStake(cartKey,v){
  let n=Math.floor(Number(v)||0);
  if(n<1)n=1;
  if(n>demoPoints)n=demoPoints;
  demoCart=demoCart.map(x=>x.cartKey===cartKey?({...x,stake:n}):x);
  demoPersistCart();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoRemoveCartItem(cartKey){
  demoCart=demoCart.filter(x=>x.cartKey!==cartKey);
  demoPersistCart();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoClearCart(){
  if(!demoCart.length)return;
  demoCart=[];
  demoPersistCart();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
  demoToast("ベットリストをすべて削除しました");
}

function demoCartTotal(){
  return demoCart.reduce((sum,x)=>sum+(Number(x.stake)||0),0);
}
function demoOpenCart(){
  demoCartOpen=true;
  demoBetModalOpen=false;
  demoCompleteData=null;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoCloseCart(){
  demoCartOpen=false;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoSubmitCart(){
  if(!demoCart.length)return;
  const closedItems=demoCart.filter(demoCartItemClosed);
  if(closedItems.length){
    demoToast("締切済みの買い目は購入できません");
    alert("締切済みの買い目が含まれています。削除してから投票してください。");
    const panel=document.getElementById("demoBetRoot");
    if(panel)panel.innerHTML=renderDemoBetInner();
    return;
  }
  const total=demoCartTotal();
  if(total>demoPoints){
    alert("所持ptが不足しています。");
    return;
  }
  demoPoints-=total;
  demoSavePoints();

  let history=[];
  try{ history=JSON.parse(localStorage.getItem("boatCheckDemoHistory")||"[]"); }catch(e){}
  const receiptNo=String((history.length+1)%10000).padStart(4,"0");
  const submitted=demoCart.map(x=>({...x}));
  history.unshift({
    at:new Date().toISOString(),
    receiptNo,
    total,
    bets:submitted
  });
  localStorage.setItem("boatCheckDemoHistory",JSON.stringify(history.slice(0,100)));

  demoCompleteData={
    receiptNo,
    total,
    count:submitted.length,
    bets:submitted
  };
  demoCart=[];
  demoPersistCart();
  demoCartOpen=false;

  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoCloseComplete(){
  demoCompleteData=null;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}

function demoCloseDraftModal(){
  demoBetModalOpen=false;
  demoDraftList=[];
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoSetDraftStake(v){
  let n=Math.floor(Number(v)||0);
  if(n<1)n=1;
  if(n>demoPoints)n=demoPoints;
  demoStake=n;
  demoDraftList=demoDraftList.map(x=>({...x,stake:n}));
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoDraftTotal(){
  return demoDraftList.reduce((sum,x)=>sum+(Number(x.stake)||0),0);
}
function demoMergeDraft(){
  demoDraftList.forEach(item=>{
    const idx=demoBetList.findIndex(x=>x.key===item.key);
    if(idx>=0)demoBetList[idx]={...demoBetList[idx],...item};
    else demoBetList.push({...item});
  });
}
function demoDraftContinue(){
  if(!demoRequireOpenRace())return;
  if(!demoMergeDraftToCart())return;
  demoBetModalOpen=false;
  demoDraftList=[];
  demoResetSelection();
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
  demoToast("ベットリストに追加されました");
}
function demoDraftVote(){
  if(!demoRequireOpenRace())return;
  if(!demoMergeDraftToCart())return;
  demoBetModalOpen=false;
  demoDraftList=[];
  demoResetSelection();
  demoCartOpen=true;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoRemoveBet(key){
  demoBetList=demoBetList.filter(x=>x.key!==key);
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoSetStake(v){
  const n=Math.max(100,Math.floor(Number(v)||100));
  demoStake=n;
  demoBetList=demoBetList.map(x=>({...x,stake:n}));
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}
function demoSetStakeFromInput(v){
  let n=Math.floor(Number(v)||0);
  if(n<1)n=1;
  if(n>demoPoints)n=demoPoints;
  demoStake=n;
  demoBetList=demoBetList.map(x=>({...x,stake:n}));
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}

function demoSetBetStake(key,v){
  let n=Math.floor(Number(v)||0);
  if(n<1)n=1;
  if(n>demoPoints)n=demoPoints;
  demoBetList=demoBetList.map(x=>x.key===key?({...x,stake:n}):x);
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}

function demoTotalStake(){
  return demoBetList.reduce((sum,x)=>sum+(Number(x.stake)||0),0);
}
function demoConfirmBet(){
  if(!demoRequireOpenRace())return;
  const total=demoTotalStake();
  if(!demoBetList.length||total<=0)return;
  if(total>demoPoints){
    alert("所持ptが不足しています。");
    return;
  }
  demoPoints-=total;
  demoSavePoints();

  const r=state.currentRace||{};
  const history=JSON.parse(localStorage.getItem("boatCheckDemoHistory")||"[]");
  const meta=demoCurrentMeetingMeta();
  history.unshift({
    at:new Date().toISOString(),
    venueCode:meta.venueCode,
    venue:meta.venueName,
    raceNo:r.raceNo||"",
    date:meta.date,
    total,
    bets:demoBetList.map(x=>({...x,venueCode:meta.venueCode,venueName:meta.venueName,date:meta.date,raceNo:r.raceNo||""}))
  });
  localStorage.setItem("boatCheckDemoHistory",JSON.stringify(history.slice(0,100)));
  demoBetList=[];
  demoResetSelection();

  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner(`<div class="demoSuccess">デモ投票が完了しました。投資 ${demoFormatPt(total)}</div>`);
}
function demoBetTypeButtons(){
  const types=["trifecta","trio","exacta","quinella","wide","win","place"];
  return `<div class="demoBetTypes">
    ${types.map(t=>`<button class="${demoBetType===t?"active":""}" onclick="setDemoBetType('${t}')">${demoBetLabel(t)}</button>`).join("")}
  </div>`;
}
function demoMethodButtons(){
  return `<div class="demoMethods">
    ${demoAllowedMethods(demoBetType).map(m=>`<button class="${demoMethod===m?"active":""}" onclick="setDemoMethod('${m}')">${demoMethodLabel(m)}</button>`).join("")}
  </div>`;
}
function demoSelectionArea(){
  const count=demoSelectionCount(demoBetType);
  if(demoMethod==="box"){
    return `${demoLanePicker("first","選択艇")}<div class="demoHint">選択した艇の組み合わせを自動で作成します。</div>`;
  }
  if(count===1)return demoLanePicker("first","選択");
  if(count===2)return `${demoLanePicker("first",demoBetType==="exacta"?"1着":"1艇目")}${demoLanePicker("second",demoBetType==="exacta"?"2着":"2艇目")}`;
  return `${demoLanePicker("first","1着")}${demoLanePicker("second","2着")}${demoLanePicker("third","3着")}`;
}
function renderDemoBetList(){
  const total=demoTotalStake();
  return `<div class="demoBetListBox">
    <div class="demoBetListHead">
      <div><b>ベットリスト</b><span>${demoBetList.length}点</span></div>
      <strong>${demoFormatPt(total)}</strong>
    </div>
    ${demoBetList.length?`
      <div class="demoBetListRows">
        ${demoBetList.map(x=>`<div class="demoBetItem">
          <div>
            <small>${demoBetLabel(x.type)}</small>
            <strong>${oddsComboHtml(x.combo)}</strong>
          </div>
          <div class="demoBetOdds"><small>オッズ</small><b>${x.odds!==null?oddsFmt(x.odds):"--"}</b></div>
          <div class="demoBetStake">
            <small>投資pt</small>
            <div class="demoBetStakeInput">
              <input type="number" inputmode="numeric" min="1" max="${demoPoints}" step="1"
                value="${Number(x.stake)||demoStake}"
                onchange="demoSetBetStake('${x.key}',this.value)"
                aria-label="${demoBetLabel(x.type)} ${x.combo.join("-")} の投資ポイント">
              <span>pt</span>
            </div>
          </div>
          <button onclick="demoRemoveBet('${x.key}')">×</button>
        </div>`).join("")}
      </div>`:`<div class="demoBetListEmpty">選択した買い目を追加するとここに表示されます。</div>`}
    <div class="demoStakeArea">
      <div class="demoStakeTitle">
        <label>全買い目の投資ptをまとめて変更</label>
        <span>各買い目ごとの変更も可能</span>
      </div>
      <div class="demoStakeButtons">
        ${[100,200,500,1000].map(v=>`<button class="${demoStake===v?"active":""}" onclick="demoSetStake(${v})">${v.toLocaleString()}pt</button>`).join("")}
      </div>
      <div class="demoStakeInputWrap">
        <input type="number" inputmode="numeric" min="1" max="${demoPoints}" step="1"
          value="${demoStake}" onchange="demoSetStakeFromInput(this.value)"
          aria-label="1点あたりの投資ポイント">
        <span>pt / 1点</span>
      </div>
    </div>
    <div class="demoTotalConfirm">
      <div><small>合計投資</small><strong>${demoFormatPt(total)}</strong></div>
      <button class="demoConfirmBtn" ${demoBetList.length?"":"disabled"} onclick="demoConfirmBet()">デモ投票を確定</button>
    </div>
  </div>`;
}
function renderDemoNormalBet(){
  return `<div class="demoBetCard">
    <div class="demoCardTitle"><b>買い目を選択</b><span>${demoBetLabel(demoBetType)} / ${demoMethodLabel(demoMethod)}</span></div>
    ${demoBetTypeButtons()}
    ${demoMethodButtons()}
    <div class="demoSelectionPanel">
      ${demoSelectionArea()}
    </div>
    <button class="demoAddBtn" onclick="demoAddSelections()">ベットリストに追加</button>
  </div>`;
}
function renderDemoOddsBet(){
  const r=state.currentRace||{};
  const entries=sortOdds(oddsEntriesFor(r,demoBetType),"popular");
  return `<div class="demoBetCard">
    <div class="demoCardTitle"><b>オッズから選択</b><span>タップしてベットリストへ追加</span></div>
    ${demoBetTypeButtons()}
    <div class="demoOddsGrid">
      ${entries.length?entries.slice(0,60).map(e=>{
        const combo=parseCombo(e.combination??e.combo??e.number);
        const key=`${demoBetType}:${combo.join("-")}`;
        const exists=demoBetList.some(x=>x.key===key);
        return `<button class="demoOddsItem ${exists?"selected":""}" onclick="demoAddOddsBet('${combo.join("-")}')">
          <div>${oddsComboHtml(combo)}</div>
          <strong>${oddsFmt(e.odds??e.value??e.rate)}</strong>
          <span>${exists?"追加済":"追加"}</span>
        </button>`;
      }).join(""):`<div class="demoOddsEmpty">この券種のオッズはまだ取得されていません。</div>`}
    </div>
  </div>`;
}
function demoAddOddsBet(comboStr){
  if(!demoRequireOpenRace())return;
  const combo=String(comboStr).split("-").map(Number).filter(Boolean);
  if(!combo.length)return;
  demoDraftList=[{
    key:`${demoBetType}:${combo.join("-")}`,
    type:demoBetType,
    combo,
    odds:demoCurrentOdds(combo),
    stake:demoStake
  }];
  demoBetModalOpen=true;
  const panel=document.getElementById("demoBetRoot");
  if(panel)panel.innerHTML=renderDemoBetInner();
}

function demoVenueLabel(){
  const m=state.currentMeetingView||state.currentMeeting||{};
  return m.name || m.venueName || VENUES.find(v=>v.code===state.currentVenue)?.name || "--";
}
function renderDemoDraftModal(){
  if(!demoBetModalOpen)return "";
  const r=state.currentRace||{};
  const total=demoDraftTotal();

  return `<div class="demoModalBackdrop">
    <div class="demoDraftModal" role="dialog" aria-modal="true" aria-label="ベットリスト追加">
      <div class="demoDraftHead">
        <b>ベットリスト追加</b>
        <button onclick="demoCloseDraftModal()">×</button>
      </div>

      <div class="demoDraftRace">
        <strong>${esc(demoVenueLabel())} ${r.raceNo||"--"}R</strong>
        <span>${demoBetLabel(demoBetType)}</span>
      </div>

      <div class="demoDraftTable">
        <div class="demoDraftTableHead">
          <span>勝式</span><span>組番</span><span>オッズ</span>
        </div>
        ${demoDraftList.map(x=>`<div class="demoDraftRow">
          <span>${demoBetLabel(x.type)}</span>
          <strong>${oddsComboHtml(x.combo)}</strong>
          <b>${x.odds!==null?oddsFmt(x.odds):"--"}</b>
        </div>`).join("")}
      </div>

      <div class="demoDraftStake">
        <div>
          <label>購入ポイント</label>
          <small>1点あたり</small>
        </div>
        <div class="demoDraftStakeInput">
          <input type="number" inputmode="numeric" min="1" max="${demoPoints}" step="1"
            value="${demoStake}" onchange="demoSetDraftStake(this.value)">
          <span>pt</span>
        </div>
      </div>

      <div class="demoDraftSummary">
        <span>合計 ${demoDraftList.length}点</span>
        <strong>${demoFormatPt(total)}</strong>
      </div>

      <div class="demoDraftActions">
        <button class="continue" onclick="demoDraftContinue()">ベットリストに追加して<br>入力を続ける</button>
        <button class="vote" onclick="demoDraftVote()">ベットリストに追加して<br>投票する</button>
      </div>

      <button class="demoDraftClose" onclick="demoCloseDraftModal()">閉じる</button>
    </div>
  </div>`;
}


function renderDemoCart(){
  if(!demoCartOpen)return "";
  const total=demoCartTotal();
  const hasClosed=demoCart.some(demoCartItemClosed);
  return `<div class="demoModalBackdrop">
    <div class="demoCartModal" role="dialog" aria-modal="true" aria-label="ベットリスト">
      <div class="demoCartHead">
        <div><b>ベットリスト</b><span>${demoCart.length}点</span></div>
        <div class="demoCartHeadActions">
          <button class="demoClearAllBtn" ${demoCart.length?"":"disabled"} onclick="demoClearCart()">全削除</button>
          <button class="demoCartCloseBtn" onclick="demoCloseCart()">×</button>
        </div>
      </div>
      <div class="demoCartBody">
        ${demoCart.length ? demoCart.map((x,i)=>{
          const closed=demoCartItemClosed(x);
          return `
          <div class="demoCartRaceItem ${closed?"isClosed":""}">
            <div class="demoCartMeta">
              <div>
                <strong>${esc(x.venueName||"--")} ${x.raceNo||"--"}R</strong>
                <span>${esc(x.date||"")} ${x.deadline?`締切 ${esc(x.deadline)}`:""} ${closed?'<em class="demoClosedBadge">締切済</em>':""}</span>
              </div>
              <small>${demoBetLabel(x.type)}</small>
            </div>
            <div class="demoCartBetRow">
              <div class="demoCartCombo">
                <small>買い目</small>
                <strong>${oddsComboHtml(x.combo)}</strong>
              </div>
              <div class="demoCartOdds">
                <small>オッズ</small>
                <b>${x.odds!==null&&x.odds!==undefined?oddsFmt(x.odds):"--"}</b>
              </div>
              <div class="demoCartStake">
                <small>投資pt</small>
                <div class="demoCartStakeInput">
                  <input type="number" inputmode="numeric" min="1" max="${demoPoints}" step="1"
                    value="${Number(x.stake)||demoStake}" ${closed?"disabled":""}
                    onchange="demoSetCartStake('${x.cartKey}',this.value)">
                  <span>pt</span>
                </div>
              </div>
              <button class="demoCartDelete" onclick="demoRemoveCartItem('${x.cartKey}')" aria-label="この買い目を削除">
  <span class="demoDeleteText">削除</span>
</button>
            </div>
          </div>
        `}).join("") : `<div class="demoCartEmpty">ベットリストは空です。</div>`}
      </div>
      <div class="demoCartSummary">
        <div><small>合計ベット数</small><strong>${demoCart.length}点</strong></div>
        <div><small>合計投資</small><strong>${demoFormatPt(total)}</strong></div>
        <div><small>投票後残高</small><strong>${demoFormatPt(Math.max(0,demoPoints-total))}</strong></div>
      </div>
      ${hasClosed?`<div class="demoCartClosedWarning">締切済みの買い目が含まれています。削除すると投票できます。</div>`:""}
      <div class="demoCartActions">
        <button class="back" onclick="demoCloseCart()">入力に戻る</button>
        <button class="submit" ${demoCart.length&&!hasClosed?"":"disabled"} onclick="demoSubmitCart()">まとめて投票する</button>
      </div>
    </div>
  </div>`;
}
function renderDemoComplete(){
  if(!demoCompleteData)return "";
  const d=demoCompleteData;
  return `<div class="demoModalBackdrop">
    <div class="demoCompleteModal" role="dialog" aria-modal="true" aria-label="投票完了">
      <div class="demoCompleteHead">
        <span>✓</span>
        <div><b>投票完了</b><small>ご投票ありがとうございました。</small></div>
      </div>
      <div class="demoCompleteMessage">以下の通り、デモ投票が完了しました。</div>
      <div class="demoCompleteList">
        ${d.bets.map((x,i)=>`
          <div class="demoCompleteRow">
            <div class="demoCompleteNo">${i+1}</div>
            <div class="demoCompleteMain">
              <small>${esc(x.venueName||"--")} ${x.raceNo||"--"}R / ${demoBetLabel(x.type)}</small>
              <strong>${oddsComboHtml(x.combo)}</strong>
            </div>
            <div class="demoCompleteAmount">${demoFormatPt(x.stake)}</div>
            <div class="demoCompleteStatus">○ 成立</div>
          </div>`).join("")}
      </div>
      <div class="demoCompleteSummary">
        <div class="demoReceipt"><small>受付番号</small><strong>${esc(d.receiptNo)}</strong></div>
        <div><small>合計ベット数</small><strong>${d.count}点</strong></div>
        <div><small>合計投資</small><strong>${demoFormatPt(d.total)}</strong></div>
      </div>
      <button class="demoCompleteClose" onclick="demoCloseComplete()">閉じる</button>
    </div>
  </div>`;
}

function renderDemoBetInner(message=""){
  const r=state.currentRace||{};
  const closed=demoCurrentRaceClosed();
  return `<div class="demoBetPage">
    ${message}
    <div class="demoTop">
      <div>
        <h3>デモ投票</h3>
        <p>実際のお金は使用しません</p>
      </div>
      <div class="demoPoints"><small>所持pt</small><b>${demoFormatPt(demoPoints)}</b></div>
    </div>

    <div class="demoRaceBar">
      <div><b>${r.raceNo||"--"}R</b><span>${esc(r.title||"レース")}</span></div>
      <strong>締切 ${esc(r.deadline||"--:--")}</strong>
    </div>

    <div class="demoMainTabs">
      <button class="${demoMainTab==="bet"?"active":""}" ${closed?"disabled":""} onclick="setDemoMainTab('bet')">投票</button>
      <button class="${demoMainTab==="odds"?"active":""}" ${closed?"disabled":""} onclick="setDemoMainTab('odds')">オッズ投票</button>
    </div>

    <button class="demoCartShortcut" onclick="demoOpenCart()">
      <span>ベットリスト</span>
      <b>${demoCart.length}点</b>
    </button>

    ${demoRacerHeader()}

    <div class="demoBody">
      ${closed?`<div class="demoClosedNotice"><b>このレースは締切済みです</b><span>締切予定時刻を過ぎたため、新しいデモ投票はできません。</span></div>`:(demoMainTab==="bet"?renderDemoNormalBet():renderDemoOddsBet())}
    </div>

    <div class="demoSafety">
      <b>デモ投票について</b>
      <span>仮想ptを使った練習機能です。実際の舟券購入機能ではなく、ptの購入・換金・景品交換や現金の授受はできません。</span>
    </div>

    ${closed?"":renderDemoDraftModal()}
    ${renderDemoCart()}
    ${renderDemoComplete()}
  </div>`;
}

function showRaceData(type, btn){
  currentQuickDataType=type||"";
  const panel=$("quickDataPanel");
  const r=state.currentRace||{};
  const labels={racer:"選手情報",course:"コース別情報",meet:"節間成績",motor:"モーター情報",before:"直前情報",odds:"オッズ",result:"結果",replay:"リプレイ",demo:"デモ投票"};
  if(type==="racer"){
    loadOnce("directory",loadRacerDirectory).catch(console.warn);
    loadOnce("entry",loadEntryDetails).catch(console.warn);
    loadOnce("course",loadCourseStatsData).catch(console.warn);
  }
  if(type==="course"){
    if(courseSubTab==="last20")loadOnce("history",loadRecent20Data).catch(console.warn);
    if(courseSubTab==="rate")loadOnce("course",loadCourseStatsData).catch(console.warn);
  }
  if(type==="motor")loadOnce("entry",loadEntryDetails).catch(console.warn);

  document.querySelectorAll("#raceDataTabs button").forEach(b=>b.classList.remove("active"));
  if(btn){
    btn.classList.add("active");
    btn.scrollIntoView({behavior:"instant",inline:"center",block:"nearest"});
  }

  if(type==="racer"){panel.innerHTML=renderRacerInfo();return;}
  if(type==="course"){panel.innerHTML=renderCourseInfo();return;}
  if(type==="meet"){
    try{
      panel.innerHTML=renderMeetResults();
    }catch(err){
      console.error("meet results render error",err);
      panel.innerHTML=`<div class="dataSection meetResults">
        <div class="dataSectionHead"><b>節間成績</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">節間成績の表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="motor"){
    try{
      motorInnerTab="motor";
      panel.innerHTML=renderMotorInfo();
    }catch(err){
      console.error("motor info render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>モーター情報</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">モーター情報の表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="before"){
    try{
      panel.innerHTML=renderBeforeInfo();
    }catch(err){
      console.error("before info render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>直前情報</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">直前情報の表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="odds"){
    try{
      panel.innerHTML=renderOddsInfo();
    }catch(err){
      console.error("odds render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>オッズ</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">オッズ表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="result"){
    try{
      panel.innerHTML=renderResultInfo();
    }catch(err){
      console.error("result render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>結果</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">結果表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="replay"){
    try{
      panel.innerHTML=renderReplayInfo();
    }catch(err){
      console.error("replay render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>リプレイ</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">リプレイ表示できませんでした。ページを再読み込みしてください。</p>
      </div>`;
    }
    return;
  }
  if(type==="demo"){
    try{
      panel.innerHTML=`<div id="demoBetRoot">${renderDemoBetInner()}</div>`;
    }catch(err){
      console.error("demo bet render error",err);
      panel.innerHTML=`<div class="dataSection">
        <div class="dataSectionHead"><b>デモ投票</b><span>表示エラー</span></div>
        <p class="dataPlaceholder">デモ投票画面を読み込み中です。</p>
      </div>`;
    }
    return;
  }

  const dataMap={
    meet:r.meetResults||r.meetData||null,
    motor:r.motorData||r.motors||null,
    before:r.beforeData||r.before||r.exhibition||r.exhibitionData||null,
    odds:r.odds||r.oddsData||null,
    result:r.result||r.raceResult||null
  };
  const data=dataMap[type];
  const hasData=data && (Array.isArray(data) ? data.length : (typeof data==="object" ? Object.keys(data).length : true));
  if(!hasData){
    panel.innerHTML=`<div class="dataSection"><div class="dataSectionHead"><b>${labels[type]}</b><span>データ未取得</span></div><p class="dataPlaceholder">この項目のデータは現在表示できません。</p></div>`;
    return;
  }
  const raw=typeof data==="string" ? data : JSON.stringify(data);
  panel.innerHTML=`<div class="dataSection"><div class="dataSectionHead"><b>${labels[type]}</b><span>取得済み</span></div><p class="dataPlaceholder">${esc(raw.length>320?raw.slice(0,320)+"…":raw)}</p></div>`;
}
function showVenue(){
  $("detail").classList.add("hidden");
  $("home").classList.add("hidden");
  $("venue").classList.remove("hidden");
  const m=state.currentMeeting;
  const view=state.currentMeetingView||m;
  if(m&&view){
    renderMeetDayTabs(m,state.currentDayDate||view.date||m.date);
    updateVenueSelectedDayBanner(m,state.currentDayDate||view.date||m.date);
    renderRaceJump(view);
    renderRaces(view);
  }
  scrollTo({top:0,behavior:"instant"});
}

function showHome(){
  $("venue").classList.add("hidden");
  $("detail").classList.add("hidden");
  $("home").classList.remove("hidden");
  setHomeTab("venues");
}
function backToVenue(){$("detail").classList.add("hidden");$("venue").classList.remove("hidden");scrollTo({top:0,behavior:"instant"})}


function demoResultCombo(v){
  if(Array.isArray(v))return v.map(Number).filter(n=>n>=1&&n<=6);
  return String(v??"").match(/[1-6]/g)?.map(Number)||[];
}
function demoNormalizeResultCombo(type,combo){
  const c=demoResultCombo(combo);
  if(["trio","quinella","wide"].includes(type))return [...c].sort((a,b)=>a-b).join("-");
  return c.join("-");
}
function demoBetTouchesRefund(bet,refund){
  const returned=new Set((Array.isArray(refund)?refund:demoResultCombo(refund)).map(Number));
  if(!returned.size)return false;
  return demoResultCombo(bet.combo).some(n=>returned.has(Number(n)));
}
function demoCanonicalBetType(type){
  const raw=String(type||"").trim().toLowerCase();
  const aliases={
    trifecta:"trifecta","3連単":"trifecta","3t":"trifecta",sanrentan:"trifecta",
    trio:"trio","3連複":"trio","3f":"trio",sanrenpuku:"trio",
    exacta:"exacta","2連単":"exacta","2t":"exacta",nirentan:"exacta",
    quinella:"quinella","2連複":"quinella","2f":"quinella",nirenpuku:"quinella",
    wide:"wide","拡連複":"wide",kakurenpuku:"wide",
    win:"win","単勝":"win",tansho:"win",
    place:"place","複勝":"place",fukusho:"place"
  };
  return aliases[raw]||raw;
}
function demoPayoutEntries(result,type){
  const payoutRoot=result?.payouts||result?.payoffs||result?.refunds||{};
  const aliases={
    trifecta:["trifecta","3t","sanrentan","3連単"],
    trio:["trio","3f","sanrenpuku","3連複"],
    exacta:["exacta","2t","nirentan","2連単"],
    quinella:["quinella","2f","nirenpuku","2連複"],
    wide:["wide","kakurenpuku","拡連複"],
    win:["win","tansho","単勝"],
    place:["place","fukusho","複勝"]
  };
  for(const key of aliases[type]||[type]){
    const value=payoutRoot?.[key];
    if(value!==undefined&&value!==null&&value!=="")return normalizePayoutCombos(value);
  }
  return [];
}
function demoOfficialPayoutForBet(race,bet){
  const result=race?.result||race?.raceResult||{};
  const finishers=resultEntries(race);
  const ranked=finishers.map((x,i)=>({
    lane:Number(resultEntryValue(x,["lane","boatNo","frame","waku","number"]))||i+1,
    rank:Number(resultEntryValue(x,["rank","finish","arrival","place","finishPlace"]))
  })).filter(x=>x.lane>=1&&x.lane<=6&&x.rank>=1&&x.rank<=6);
  const hasOfficialOrder=[1,2,3].every(rank=>ranked.some(x=>x.rank===rank));
  const status=String(result?.status||result?.state||"").toLowerCase();
  const isOfficial=result?.official===true||/official|final|確定|終了/.test(status)||hasOfficialOrder;
  if(!isOfficial)return null;

  const refund=result?.refund||result?.returnedBoat||result?.return||[];
  if(demoBetTouchesRefund(bet,refund)){
    return {settled:true,status:"refund",hit:false,refunded:true,officialPayout:0};
  }

  const type=demoCanonicalBetType(bet.type);
  const list=demoPayoutEntries(result,type);
  const target=demoNormalizeResultCombo(type,bet.combo);

  const found=list.find(x=>
    demoNormalizeResultCombo(type,x?.combination??x?.combo??x?.number)===target
  );

  if(found){
    const amount=Number(found.payout??found.amount??found.value);
    if(Number.isFinite(amount)){
      return {settled:true,status:"hit",hit:true,refunded:false,officialPayout:amount};
    }
  }
  // 払戻表に載るのは的中目だけ。公式確定後に一致しない買い目は不的中として確定する。
  if(list.length)return {settled:true,status:"miss",hit:false,refunded:false,officialPayout:0};

  // 古い保存データで払戻のキー形式が異なる場合も、着順から明らかな外れを確定する。
  if(hasOfficialOrder){
    const order=[1,2,3].map(rank=>ranked.find(x=>x.rank===rank)?.lane).filter(Boolean);
    let winning="";
    if(type==="trifecta")winning=order.join("-");
    if(type==="trio")winning=[...order].sort((a,b)=>a-b).join("-");
    if(type==="exacta")winning=order.slice(0,2).join("-");
    if(type==="quinella")winning=order.slice(0,2).sort((a,b)=>a-b).join("-");
    if(type==="win")winning=String(order[0]||"");
    if(winning&&target!==winning)return {settled:true,status:"miss",hit:false,refunded:false,officialPayout:0};
  }
  return null;
}
function demoBuildSettlementRaceMap(){
  const raceMap=new Map();

  (state.meetings||[]).forEach(m=>{
    const code=String(m.venueCode||"").padStart(2,"0");

    (m.races||[]).forEach(r=>{
      raceMap.set(`${code}:${m.date||""}:${Number(r.raceNo)||0}`,r);
    });

    (m.meetDays||[]).forEach(d=>{
      (d.races||[]).forEach(r=>{
        const key=`${code}:${d.date||""}:${Number(r.raceNo)||0}`;
        if(!raceMap.has(key)||(r.result||{}).official===true)raceMap.set(key,r);
      });
    });
  });

  (state.recentResults||[]).forEach(x=>{
    raceMap.set(
      `${String(x.venueCode||"").padStart(2,"0")}:${x.date||""}:${Number(x.raceNo)||0}`,
      {raceNo:Number(x.raceNo)||0,result:x.result||{},resultUpdatedAt:x.resultUpdatedAt||null}
    );
  });

  return raceMap;
}
function demoVenueCodeFromName(name){
  const target=String(name||"").replace(/\s+/g,"").trim();
  if(!target)return "";
  const hit=VENUES.find(v=>String(v?.[1]||"").replace(/\s+/g,"").trim()===target);
  return hit?String(hit[0]).padStart(2,"0"):"";
}
function demoSettlementKeyForBet(b,h){
  const rawCode=b.venueCode||h.venueCode||"";
  const venueName=b.venueName||h.venueName||h.venue||"";
  const venueCode=rawCode
    ? String(rawCode).padStart(2,"0")
    : demoVenueCodeFromName(venueName);
  const date=String(b.date||h.date||"");
  const raceNo=Number(b.raceNo||h.raceNo)||0;
  return `${venueCode}:${date}:${raceNo}`;
}
function demoSettlementStatusText(b){
  if(b.refunded||b.status==="refund")return "返還";
  if(b.settled!==true)return "結果待ち";
  if(b.hit===true||b.status==="hit")return "的中";
  return "不的中";
}
function demoSettleHistoryFromOfficialResults(){
  let history=[];
  try{history=JSON.parse(localStorage.getItem("boatCheckDemoHistory")||"[]");}
  catch(e){return;}
  if(!Array.isArray(history)||!history.length)return;

  const raceMap=demoBuildSettlementRaceMap();
  let changed=false;
  let creditTotal=0;
  let hitCount=0;
  let refundCount=0;
  let settledCount=0;

  history.forEach(h=>{
    (h.bets||[]).forEach(b=>{
      if(b.settled===true)return;

      const race=raceMap.get(demoSettlementKeyForBet(b,h));
      if(!race)return;

      const settlement=demoOfficialPayoutForBet(race,b);
      if(!settlement?.settled)return;

      const stake=Math.max(0,Number(b.stake)||0);
      let payout=0;

      if(settlement.status==="refund"){
        payout=stake;
        refundCount+=1;
      }else if(settlement.status==="hit"){
        payout=Math.max(0,Math.round((stake/100)*Number(settlement.officialPayout||0)));
        hitCount+=1;
      }

      b.settled=true;
      b.status=settlement.status;
      b.hit=settlement.status==="hit";
      b.refunded=settlement.status==="refund";
      b.payout=payout;
      b.officialPayout=Number(settlement.officialPayout||0);
      b.settledAt=new Date().toISOString();

      changed=true;
      settledCount+=1;
      creditTotal+=payout;
    });

    if(Array.isArray(h.bets)){
      h.settled=h.bets.length>0&&h.bets.every(b=>b.settled===true);
      h.payout=h.bets.reduce((s,b)=>s+(Number(b.payout)||0),0);
      h.hitCount=h.bets.filter(b=>b.hit===true).length;
      h.refundCount=h.bets.filter(b=>b.refunded===true).length;
      h.status=h.settled
        ? (h.hitCount>0?"hit":(h.refundCount===h.bets.length?"refund":"settled"))
        : "pending";
    }
  });

  if(!changed)return;

  localStorage.setItem("boatCheckDemoHistory",JSON.stringify(history.slice(0,100)));

  if(creditTotal>0){
    demoPoints+=creditTotal;
    demoSavePoints();

    const ptHist=homePtHistory();
    ptHist.unshift({
      at:new Date().toISOString(),
      amount:creditTotal,
      balance:demoPoints,
      type:"payout",
      label:hitCount>0
        ? `デモ投票 払戻${refundCount?`・返還含む`:""}`
        : "デモ投票 返還"
    });
    homeSaveJson("boatCheckPtHistory",ptHist.slice(0,200));
  }

  refreshHomeActivePanel();

  if(settledCount){
    let msg=`${settledCount}点の投票結果を反映`;
    if(hitCount)msg+=`・的中${hitCount}点`;
    if(refundCount)msg+=`・返還${refundCount}点`;
    if(creditTotal>0)msg+=` +${creditTotal.toLocaleString("ja-JP")}pt`;
    demoToast(msg);
  }
}

function refreshCurrentQuickDataPanel(){
  const panel=$("quickDataPanel");
  if(!panel || !currentQuickDataType)return;

  try{
    if(currentQuickDataType==="racer")panel.innerHTML=renderRacerInfo();
    if(currentQuickDataType==="odds")panel.innerHTML=renderOddsInfo();
    if(currentQuickDataType==="before")panel.innerHTML=renderBeforeInfo();
    if(currentQuickDataType==="result")panel.innerHTML=renderResultInfo();
    if(currentQuickDataType==="replay")panel.innerHTML=renderReplayInfo();
  }catch(err){
    console.warn("quick data live refresh skipped",err);
  }
}
async function refreshOfficialData(){
  if(document.hidden)return;
  if(bcSelectedOffset!==0)return;
  if(refreshingLive)return;
  refreshingLive=true;

  const currentVenueCode=state.currentMeeting?.venueCode||state.currentMeetingView?.venueCode||null;
  const currentDayDate=state.currentMeetingView?.date||state.currentDayDate||null;
  const currentRaceNo=Number(state.currentRace?.raceNo)||null;
  const previousDate=state.dateJST;

  try{
    const d=await requestLiveJson(DATA_URL);
    if(!Array.isArray(d.meetings))return;
    const previous=new Map(state.meetings.map(m=>[m.venueCode,m]));
    if(d.dateJST!==state.dateJST)loadedVenues.clear();
    state.meetings=d.meetings.map(m=>{
      const full=loadedVenues.has(m.venueCode)?previous.get(m.venueCode):null;
      if(!full||full.date!==m.date)return m;
      Object.assign(full,Object.fromEntries(Object.entries(m).filter(([k])=>k!=="races"&&k!=="meetDays")));
      const fresh=new Map((m.races||[]).map(r=>[Number(r.raceNo),r]));
      (full.races||[]).forEach(r=>{
        const small=fresh.get(Number(r.raceNo));
        if(small)for(const k of ("deadline status statusLabel note").split(" "))if(k in small)r[k]=small[k];
      });
      return full;
    });
    state.errors=d.errors||[];
    state.updatedAt=d.updatedAt;state.dailyOverview=d.dailyOverview||null;
    state.dateJST=d.dateJST;
    $("todayLabel").textContent=formatDataDate(d.dateJST);
    $("dataState").innerHTML=`<strong>公開データ参照</strong>${esc(dataFreshnessLabel(d.updatedAt))}`;
    $("loadError").classList.add("hidden");
    clearTimeout(homeRetryTimer);

    if(currentVenueCode){
      let m=state.meetings.find(x=>x.venueCode===currentVenueCode);
      if(m){
        if(previousDate!==state.dateJST&&currentDayDate===previousDate){
          await ensureVenue(currentVenueCode);
          m=state.meetings.find(x=>x.venueCode===currentVenueCode);
        }
        if(loadedVenues.has(currentVenueCode)){
          try{mergeVenueLive(m,await requestLiveJson(`data/venue-live/${currentVenueCode}.json`));}
          catch(error){console.warn("Venue LIVE data unavailable",error);}
        }
        state.currentMeeting=m;
        state.currentDayDate=previousDate!==state.dateJST&&currentDayDate===previousDate?m.date:currentDayDate||m.date;
        state.currentMeetingView=currentDayView(m,state.currentDayDate);
        if(currentRaceNo){
          state.currentRace=hydrateRaceForDisplay((state.currentMeetingView?.races||[]).find(r=>Number(r.raceNo)===currentRaceNo)||state.currentRace);
        }
      }
    }

    demoSettleHistoryFromOfficialResults();
    loadSettlements();
    renderVenues();
    refreshHomeActivePanel();

    if(!$("venue").classList.contains("hidden") && state.currentMeetingView){
      renderRaces(state.currentMeetingView);
    }
    if(!$("detail").classList.contains("hidden") && state.currentRace){
      renderRaceContext();
      refreshCurrentQuickDataPanel();
    }
  }catch(e){
    console.warn("background official data refresh failed",e);
    $("dataState").textContent=`データ更新を確認中・保存 ${formatUpdated(state.updatedAt)}`;
  }finally{
    refreshingLive=false;
  }
}

async function loadData(){
  if(!state.meetings.length){
    try{const cached=JSON.parse($("homeSnapshot")?.textContent||"null");
      if(cached?.meetings){state.meetings=cached.meetings;state.dateJST=cached.dateJST;state.updatedAt=cached.updatedAt;state.dailyOverview=cached.dailyOverview;
        $("todayLabel").textContent=formatDataDate(cached.dateJST);
        $("dataState").textContent=`公開情報をもとに更新・保存 ${formatUpdated(cached.updatedAt)}`;
      }
    }catch(error){console.warn("Home snapshot unavailable",error);}
  }
  try{
    const d=await requestLiveJson(DATA_URL);
    if(!Array.isArray(d.meetings))throw new Error("meetings invalid");
    state.errors=d.errors||[];
    state.meetings=adoptHomeMeetings(d);state.updatedAt=d.updatedAt;state.dateJST=d.dateJST;state.dailyOverview=d.dailyOverview||null;
    $("todayLabel").textContent=formatDataDate(d.dateJST);
    $("dataState").innerHTML=`<strong>公開データ参照</strong>${esc(dataFreshnessLabel(d.updatedAt))}`;
    $("loadError").classList.add("hidden");
    clearTimeout(homeRetryTimer);
    renderVenues();
    demoSettleHistoryFromOfficialResults();
    loadSettlements();
    refreshHomeActivePanel();
  }catch(e){
    $("dataState").textContent=`データ更新を確認中${state.updatedAt?`・保存 ${formatUpdated(state.updatedAt)}`:""}`;
    $("loadError").classList.add("hidden");
    clearTimeout(homeRetryTimer);
    homeRetryTimer=setTimeout(()=>{homeLoadPromise=loadData();},30000);
    console.warn("Home LIVE unavailable; dated cards retained",e);
  }
}


async function loadEntryDetails(){
  try{
    const res=await fetch(`data/entry-details.json?v=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)return;
    const data=await res.json();
    if(data.schemaVersion!==1||!data.byRacer||!data.motorsByVenue)return;
    state.entryDetails=data;
    const panel=document.getElementById("quickDataPanel");
    if(panel&&currentQuickDataType==="racer")panel.innerHTML=renderRacerInfo();
    if(panel&&currentQuickDataType==="motor")panel.innerHTML=renderMotorInfo();
  }catch(error){console.warn("Entry details unavailable",error);}
}

async function loadRacerDirectory(){
  try{
    const res=await fetch(`data/racers.json?v=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)return;
    state.racerDirectory=await res.json();
    if(currentQuickDataType==="racer")$("quickDataPanel").innerHTML=renderRacerInfo();
  }catch(error){console.warn("Racer directory unavailable",error);}
}

async function loadCourseStatsData(){
  try{
    const res=await fetch(`data/course-stats.json?v=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const data=await res.json();
    if(data.schemaVersion!==1 || !data.byRacer || typeof data.byRacer!=="object")throw new Error("Invalid course stats");
    state.racerOverallById=data.overallByRacer||{};
    state.courseStatsByRacer=data.byRacer;state.courseStatsMeta={to:data.to,errors:data.errors||[]};
    if(currentQuickDataType==="racer")$("quickDataPanel").innerHTML=renderRacerInfo();
    if(currentQuickDataType==="course" && courseSubTab==="rate"){
      const panel=document.getElementById("courseInnerPanel");if(panel)panel.innerHTML=renderCourseRate();
    }
  }catch(error){console.warn("Course stats load failed",error);}
}
async function loadRecent20Data(){
  try{
    const res=await fetch(`${RECENT20_URL}?v=${Date.now()}`,{cache:"no-store"});
    if(!res.ok)return;
    const d=await res.json();
    let byRacer=d?.byRacer||d?.recent20ByRacer||d;
    if(d?.compact===true&&Number(d?.schemaVersion)>=2&&byRacer&&typeof byRacer==="object"){
      const venueNames=d.venueNames||{};
      const grades=Array.isArray(d.grades)?d.grades:[];
      const kimarite=Array.isArray(d.kimarite)?d.kimarite:[];
      byRacer=Object.fromEntries(Object.entries(byRacer).map(([racerId,rows])=>[
        racerId,
        (Array.isArray(rows)?rows:[]).map(row=>({
          date:`20${String(row[0]||"").slice(0,2)}-${String(row[0]||"").slice(2,4)}-${String(row[0]||"").slice(4,6)}`,
          venueCode:String(row[1]||"").padStart(2,"0"),
          venueName:venueNames[String(row[1]||"").padStart(2,"0")]||"--",
          grade:grades[Number(row[2])]||"一般",
          raceNo:Number(row[3])||0,
          lane:Number(row[4])||0,
          course:Number(row[5])||0,
          finish:row[6]??"--",
          kimarite:kimarite[Number(row[7])]||"",
          result:String(row[8]||"").split("").map(Number).filter(Number.isFinite),
          exhibitionTime:row[9]??null,
          st:row[10]??null,
          stRank:row[11]??null
        }))
      ]));
    }
    if(!byRacer||typeof byRacer!=="object"||Array.isArray(byRacer))return;
    state.recent20ByRacer=byRacer;
    if(currentQuickDataType==="course"&&courseSubTab==="last20"){
      const panel=document.getElementById("courseInnerPanel");
      if(panel)panel.innerHTML=renderRecent20();
    }
  }catch(e){
    console.warn("recent20 data load failed",e);
  }
}

history.replaceState({view:"home"},"",location.pathname+location.search);
window.addEventListener("popstate",async(e)=>{
  const st=e.state||{view:"home"};
  if(st.view==="home"){showHome();return;}
  if(st.view==="venue"){openVenue(st.code,false);return;}
  if(st.view==="detail"){
    try{await ensureVenue(st.code);}catch(error){console.warn("Race navigation unavailable",error);showHome();return;}
    const m=bcHomeMeetings().find(x=>x.venueCode===st.code);
    if(m){
      state.currentMeeting=m;
      state.currentDayDate=st.date||state.currentDayDate||m.date;
      state.currentMeetingView=currentDayView(m,state.currentDayDate);
      openRace(st.raceNo,false);
    }
  }
});

homeLoadPromise=loadData();
setInterval(refreshOfficialData,60000);
setInterval(()=>{
  if(!state.meetings.length)return;
  renderVenues();
  refreshHomeActivePanel();
  if(!$("venue").classList.contains("hidden") && state.currentMeetingView){
    renderRaces(state.currentMeetingView);
  }
  if(!$("detail").classList.contains("hidden") && state.currentRace){
    renderRaceContext();
    if(currentQuickDataType==="demo"){
      const panel=document.getElementById("demoBetRoot");
      if(panel)panel.innerHTML=renderDemoBetInner();
    }
  }
},30000);
