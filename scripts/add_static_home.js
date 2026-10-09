// Neutral 24-card fallback is embedded in source HTML and retained by builds.
const fs=require('fs'),path=require('path');
const root=process.argv[2]||'.',file=path.join(root,'index.html');
const names=['桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑','津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島','宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'];
const cards=names.map((name,i)=>`<div class="card off" data-code="${String(i+1).padStart(2,'0')}"><div class="nameRow"><span class="leftMark"></span><div class="venueTitle">${name}</div><span class="rightMark"></span></div><div class="offtext"><b>開催情報を確認中</b></div></div>`).join('');
const markup=`<div class="grid" id="venues"><!-- STATIC_HOME_START -->${cards}<!-- STATIC_HOME_END --></div><div class="dailyOverview" id="dailyOverview" aria-label="本日の開催状況">開催状況を確認中</div>`;
let html=fs.readFileSync(file,'utf8');
if(html.includes('<!-- STATIC_HOME_START -->')){
  html=html.replace(/<div class="grid" id="venues">[\s\S]*?<!-- STATIC_HOME_END --><\/div>(?:<div class="dailyOverview"[^>]*>[^<]*<\/div>)?/,markup);
}else{
  const needle='<div class="grid" id="venues"></div>';
  if(!html.includes(needle))throw Error('Cannot locate the home grid');
  html=html.replace(needle,markup);
}
fs.writeFileSync(file,html);
