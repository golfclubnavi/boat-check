// LIVE view delivery from Workers KV. upload_live.py POSTs the split public views
// to /ingest after each collection round; browsers read them via
// window.BOAT_CHECK_LIVE_BASE and fall back to the committed static files.
const VENUE=/^(venue|venue-live)\/(0[1-9]|1[0-9]|2[0-4])\.json$/;
const FIXED=new Set(['home-live.json','settlements.json']);
const ORIGINS=new Set(['https://boatcheck.jp','https://www.boatcheck.jp']);
const FUTURE_TOLERANCE_MS=5*60*1000;

const allowed=name=>FIXED.has(name)||VENUE.test(name);

async function digest(text){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

function cors(request){
  const origin=request.headers.get('Origin');
  return ORIGINS.has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{};
}

function json(body,status,extra={}){
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
}

async function ingest(request,env){
  const auth=request.headers.get('Authorization')||'';
  if(!env.INGEST_TOKEN||auth!==`Bearer ${env.INGEST_TOKEN}`)return json({ok:false,error:'unauthorized'},401);
  let payload;
  try{payload=await request.json();}catch{return json({ok:false,error:'invalid json'},400);}
  const files=payload?.files;
  const home=files?.['home-live.json'];
  if(!files||typeof files!=='object'||!home)return json({ok:false,error:'home-live.json required'},400);
  const names=Object.keys(files);
  if(names.some(name=>!allowed(name)))return json({ok:false,error:'file not allowed'},400);
  const updated=Date.parse(home.updatedAt);
  if(!Number.isFinite(updated)||updated>Date.now()+FUTURE_TOLERANCE_MS)return json({ok:false,error:'invalid updatedAt'},400);
  if(!Array.isArray(home.venues)||home.venues.length!==24)return json({ok:false,error:'24 venues required'},400);
  for(const name of names){
    if(VENUE.test(name)&&String(files[name]?.date)!==String(home.dateJST))return json({ok:false,error:`${name}: date mismatch`},400);
  }
  const current=await env.LIVE.get('meta',{type:'json'});
  // Equal timestamps are a re-upload of the same round, not new data.
  if(current&&(String(current.dateJST)>String(home.dateJST)||(String(current.dateJST)===String(home.dateJST)&&Date.parse(current.updatedAt)>=updated)))
    return json({ok:true,skipped:'older version'},200);
  // Unchanged views are not rewritten: KV write quotas are per key write.
  const hashes={...(current?.hashes||{})};
  let written=0;
  const store=async name=>{
    const body=JSON.stringify(files[name]),hash=await digest(body);
    if(hashes[name]===hash)return;
    await env.LIVE.put(name,body);hashes[name]=hash;written++;
  };
  // home-live.json goes last so readers never see a home that points at missing venues.
  for(const name of names.filter(n=>n!=='home-live.json'))await store(name);
  await store('home-live.json');
  await env.LIVE.put('meta',JSON.stringify({dateJST:home.dateJST,updatedAt:home.updatedAt,files:names.length,hashes}));
  return json({ok:true,updatedAt:home.updatedAt,files:names.length,written},200);
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const name=url.pathname.replace(/^\/+/,'');
    if(request.method==='POST'&&name==='ingest')return ingest(request,env);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors(request),'Access-Control-Allow-Methods':'GET','Access-Control-Max-Age':'86400'}});
    if(request.method!=='GET'||!allowed(name))return json({ok:false,error:'not found'},404,cors(request));
    const body=await env.LIVE.get(name);
    if(body===null)return json({ok:false,error:'not found'},404,cors(request));
    return new Response(body,{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors(request)}});
  }
};
