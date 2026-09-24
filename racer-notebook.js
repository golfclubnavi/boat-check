/* Additive UI. Existing bet, points and favorites storage keys are unchanged. */
let bcSelectedOffset=0;
let bcDayPayload=null;
let bcDayStatus='';
let bcDayRequest=0;
let bcRacerReturnFocus=null;
const bcNoteKey='boatCheckRacerNotesV1';
const bcScoreFields=['スタート力','旋回力','直線力','安定感','コース対応力'];
function bcDayKey(offset=bcSelectedOffset){
  const today=jstNow().date;
  const d=new Date(`${today.slice(0,4)}-${today.slice(4,6)}-${today.slice(6,8)}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate()+offset);
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d).replaceAll('-','');
}
function bcHomeMeetings(){
  if(bcSelectedOffset===0)return state.dateJST===bcDayKey(0)?state.meetings:[];
  return bcDayPayload?.dateJST===bcDayKey()?bcDayPayload.meetings:[];
}
function bcAbsentLabel(code){
  const payload=bcSelectedOffset===0?state:bcDayPayload;
  if(payload?.errors?.some(e=>e.venueCode===code))return '取得確認中';
  return bcSelectedOffset===0?'本日非開催':bcSelectedOffset===-1?'前日非開催':'未発表・非開催';
}
function bcRenderDayStatus(){
  document.querySelectorAll('#bcDayTabs button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i-1===bcSelectedOffset)));
  const label=document.getElementById('todayLabel');
  if(label)label.textContent=formatDataDate(bcDayKey());
  let message='';
  if(bcSelectedOffset===0){
    if(state.dateJST && state.dateJST!==bcDayKey(0))message='本日分の更新待ちです。古い日付の開催を本日として表示しません。';
  }else if(bcDayStatus==='loading')message='開催データを読み込み中…';
  else if(bcDayStatus==='error'||bcDayPayload?.dateJST!==bcDayKey())message='この日付のデータはまだ取得できていません。時間をおいて再試行してください。';
  if(message){
    document.getElementById('venues').innerHTML=`<div class="bcDayMessage" role="status">${esc(message)}${bcDayStatus==='error'?'<button type="button" onclick="bcSelectDay(bcSelectedOffset)">再試行</button>':''}</div>`;
    return true;
  }
  return false;
}
async function bcSelectDay(offset){
  if(![-1,0,1].includes(offset))return;
  bcSelectedOffset=offset;
  const token=++bcDayRequest;
  bcDayPayload=null;
  bcDayStatus=offset?'loading':'';
  renderVenues();
  if(!offset)return;
  try{
    const res=await fetch(`data/${offset<0?'yesterday':'tomorrow'}.json?v=${Date.now()}`,{cache:'no-store'});
    if(!res.ok)throw new Error('not published');
    const d=await res.json();
    if(d.dateJST!==bcDayKey(offset)||!Array.isArray(d.meetings)||d.available===false)throw new Error('day not available');
    if(token!==bcDayRequest)return;
    bcDayPayload=d;bcDayStatus='';
  }catch(e){if(token!==bcDayRequest)return;bcDayStatus='error';}
  renderVenues();
}
function bcReadNotes(){
  const notes=JSON.parse(localStorage.getItem(bcNoteKey)||'{}');
  if(!notes||typeof notes!=='object'||Array.isArray(notes))throw new Error('メモ保存形式を確認してください');
  return notes;
}
function bcRestoreNotes(notes){
  if(!notes||typeof notes!=='object'||Array.isArray(notes))throw new Error('選手メモの形式が不正です');
  const merged=bcReadNotes();
  for(const [id,n] of Object.entries(notes)){
    if(!/^\d{4}$/.test(id)||!n||typeof n!=='object')continue;
    const scores={};
    for(const k of bcScoreFields)if(['◎','○','△','×',''].includes(n.scores?.[k]))scores[k]=n.scores[k];
    merged[id]={name:String(n.name||''),memo:String(n.memo||'').slice(0,5000),scores,updatedAt:String(n.updatedAt||'')};
  }
  localStorage.setItem(bcNoteKey,JSON.stringify(merged));
}
function bcFindBoat(id,name){
  const meetings=[state.currentMeetingView,...bcHomeMeetings(),...state.meetings].filter(Boolean);
  for(const m of meetings)for(const r of m.races||[])for(const b of r.boats||[]){
    if(id?String(b.racerId||b.registrationNo)===id:cleanRacerName(b.racerName)===name)return b;
  }
  return {racerId:id,racerName:name};
}
function bcCloseRacer(){
  const dialog=document.getElementById('bcRacerDialog');
  if(dialog){dialog.close();dialog.remove();}
  bcRacerReturnFocus?.focus();
}
function bcSaveRacer(){
  const dialog=document.getElementById('bcRacerDialog');
  const status=document.getElementById('bcNoteStatus');
  const id=dialog?.dataset.racerId;
  if(!/^\d{4}$/.test(id||''))return;
  try{
    const notes=bcReadNotes(),scores={};
    dialog.querySelectorAll('[data-score]').forEach(s=>scores[s.dataset.score]=s.value);
    notes[id]={name:dialog.dataset.racerName,memo:document.getElementById('bcRacerMemo').value,scores,updatedAt:new Date().toISOString()};
    localStorage.setItem(bcNoteKey,JSON.stringify(notes));
    status.textContent='この端末に保存しました';
  }catch(e){status.textContent='保存できませんでした。入力内容をコピーして保管してください。';}
}
function bcRecentTen(b){
  const unique=new Map();
  for(const row of recent20HistoryForBoat(b)){
    const date=String(row.date||row.raceDate||'').replaceAll('-','').replaceAll('/','');
    if(!/^\d{8}$/.test(date)||date>jstNow().date)continue;
    const key=`${date}:${row.venueCode||row.venueName||row.venue}:${row.raceNo}`;
    if(!unique.has(key))unique.set(key,{...row,_date:date});
  }
  return [...unique.values()].sort((a,b)=>b._date.localeCompare(a._date)||Number(b.raceNo)-Number(a.raceNo)).slice(0,10);
}
function bcFillRecent(b){
  const target=document.getElementById('bcRacerRecent');if(!target)return;
  const rows=bcRecentTen(b);
  target.innerHTML=rows.length?`<table><thead><tr><th>日付</th><th>場・R</th><th>枠</th><th>進入</th><th>着</th><th>本番ST</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${recent20Date(r.date)}</td><td>${esc(r.venueName||r.venue||'--')} ${Number(r.raceNo)||'--'}R</td><td>${esc(r.lane??'--')}</td><td>${esc(r.course??'--')}</td><td>${esc(r.finish??'--')}</td><td>${esc(r.st??'--')}</td></tr>`).join('')}</tbody></table><p class="bcHint">全コース・取得済みの直近${rows.length}走。未取得の最新レースは含まれません。</p>`:'<p>直近成績は未取得です。架空の成績は表示しません。</p>';
}
async function bcOpenRacer(button){
  const id=button.dataset.racerId||'',name=button.dataset.racerName||'選手';
  bcCloseRacer();bcRacerReturnFocus=button;
  const b=bcFindBoat(id,name);
  let saved={},error='';
  try{saved=bcReadNotes()[id]||{};}catch(e){error='保存済みメモを読み込めません。ブラウザの保存設定をご確認ください。';}
  const writable=/^\d{4}$/.test(id)&&!error;
  const dialog=document.createElement('dialog');dialog.id='bcRacerDialog';
  dialog.dataset.racerId=id;dialog.dataset.racerName=name;dialog.setAttribute('aria-labelledby','bcRacerHeading');
  dialog.innerHTML=`<header><div><small>選手ノート · ${esc(id||'登録番号未取得')}</small><h2 id="bcRacerHeading">${esc(name)}</h2></div><button type="button" onclick="bcCloseRacer()" aria-label="選手詳細を閉じる">閉じる</button></header><p>${esc(b.class||'--')} ／ ${esc(b.branch||'--')} ／ ${esc(b.period||'--')}期</p><h3>自分のスコアカード</h3><p class="bcHint">手動評価です。公式評価・AI診断ではありません。</p><div class="bcScoreGrid">${bcScoreFields.map(k=>`<label>${k}<select data-score="${k}" onchange="bcSaveRacer()" ${writable?'':'disabled'}>${['','◎','○','△','×'].map(v=>`<option value="${v}" ${saved.scores?.[k]===v?'selected':''}>${v||'未評価'}</option>`).join('')}</select></label>`).join('')}</div><label for="bcRacerMemo"><h3>選手メモ</h3></label><textarea id="bcRacerMemo" maxlength="5000" placeholder="得意なコース、気になった走りなど" oninput="bcSaveRacer()" ${writable?'':'disabled'}>${esc(saved.memo||'')}</textarea><p id="bcNoteStatus" role="status">${esc(error||(!writable?'登録番号が取得できるまで保存できません。':'変更すると自動保存します。'))}</p><p class="bcHint">このブラウザ・このサイトのURL内に保存します。マイページのバックアップに含まれます。端末変更・ブラウザデータ削除前に書き出してください。</p><h3>直近10走</h3><div id="bcRacerRecent">読み込み中…</div>`;
  document.body.append(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();bcCloseRacer();});dialog.showModal();
  bcFillRecent(b);
  if(!recent20HistoryForBoat(b).length){await loadRecent20Data();if(document.getElementById('bcRacerDialog')===dialog)bcFillRecent(b);}
}
