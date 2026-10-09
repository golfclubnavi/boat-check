// Add a dated, readable fallback for the client-rendered home grid.
const fs=require('fs'), path=require('path');
const root=process.argv[2], p=path.join(root,'index.html');
const data=JSON.parse(fs.readFileSync(path.join(root,'data/today.json'),'utf8'));
const date=String(data.dateJST||'');
if(!/^\d{8}$/.test(date))throw Error('today.json has no valid dateJST');
const names=['桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑','津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島','宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const meetings=new Map((data.meetings||[]).map(m=>[String(m.venueCode||'').padStart(2,'0'),m]));
const cards=names.map((name,i)=>{const m=meetings.get(String(i+1).padStart(2,'0'));
  return m?`<div class="card"><div class="name">${esc(name)}</div><div class="meta">${esc(m.grade||'グレード確認中')}・${esc(m.title||'開催情報を確認中')}</div><div class="race">開催情報を表示中</div></div>`:
  `<div class="card off"><div class="name">${esc(name)}</div><div class="offtext"><b>開催情報を確認中</b></div></div>`;
}).join('');
const needle='<div class="grid" id="venues"></div>', source=fs.readFileSync(p,'utf8');
if(source.split(needle).length!==2)throw Error('Could not find unique home grid');
fs.writeFileSync(p,source.replace(needle,`<div class="grid" id="venues" data-snapshot-date="${date}">${cards}</div>`));
