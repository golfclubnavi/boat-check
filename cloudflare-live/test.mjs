import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import worker from './worker.js';
const kv=()=>{const m=new Map();return {m,async get(k,o){const v=m.get(k);return v===undefined?null:o?.type==='json'?JSON.parse(v):v;},async put(k,v){m.set(k,v);}};};
const req=(path,init={})=>new Request('https://live.test'+path,init);
const post=(env,files,token='t')=>worker.fetch(req('/ingest',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({files})}),env);

// The same payload upload_live.py builds from the committed public views.
const files={};
for(const name of ['home-live.json','settlements.json'])files[name]=JSON.parse(readFileSync(`data/${name}`,'utf8'));
for(const folder of ['venue','venue-live'])for(const f of readdirSync(`data/${folder}`))files[`${folder}/${f}`]=JSON.parse(readFileSync(`data/${folder}/${f}`,'utf8'));
const env={INGEST_TOKEN:'t',LIVE:kv()};
const ok=await post(env,files);
assert.equal(ok.status,200,await ok.clone().text());
assert.equal((await ok.json()).files,Object.keys(files).length);
const code=Object.keys(files).find(n=>n.startsWith('venue-live/'));
const got=await worker.fetch(req(`/${code}?v=123`,{headers:{Origin:'https://boatcheck.jp'}}),env);
assert.equal(got.status,200);assert.deepEqual(await got.json(),files[code]);
assert.equal(got.headers.get('Cache-Control'),'no-store');
assert.equal((await worker.fetch(req('/home-live.json',{headers:{Origin:'https://evil.example'}}),env)).headers.get('Access-Control-Allow-Origin'),null);

// Rejections leave stored data untouched.
const before=env.LIVE.m.get('home-live.json');
const newer=t=>({...structuredClone(files),'home-live.json':{...files['home-live.json'],updatedAt:t}});
const soon=new Date(Date.now()-1000).toISOString();
assert.equal((await post(env,{...newer(soon),'today.json':{}})).status,400,'only public views are accepted');
const wrongDate=newer(soon);wrongDate[code]={...wrongDate[code],date:'19990101'};
assert.equal((await post(env,wrongDate)).status,400,'venue date must match home');
const short=newer(soon);short['home-live.json'].venues=short['home-live.json'].venues.slice(1);
assert.equal((await post(env,short)).status,400,'24 venues required');
assert.equal((await worker.fetch(req('/ingest',{method:'POST',headers:{Authorization:'Bearer t'},body:'{'}),env)).status,400);
assert.equal((await post({INGEST_TOKEN:'',LIVE:kv()},files,'')).status,401,'empty secret never authorizes');
assert.equal(env.LIVE.m.get('home-live.json'),before);
assert.equal((await worker.fetch(req('/venue/25.json'),env)).status,404);
assert.equal((await worker.fetch(req('/../meta'),env)).status,404);
assert.equal((await worker.fetch(req('/meta'),env)).status,404,'internal meta key is not served');
// A genuinely newer round replaces the views.
const again=await (await post(env,newer(soon))).json();
assert.equal(again.ok,true);assert.equal(again.written,1,'only the changed home view is rewritten');
assert.equal(JSON.parse(env.LIVE.m.get('home-live.json')).updatedAt,soon);
const pre=await worker.fetch(req('/home-live.json',{method:'OPTIONS',headers:{Origin:'https://boatcheck.jp'}}),env);
assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),'https://boatcheck.jp');
const bytes=JSON.stringify({files}).length;
console.log(`[live-worker] real ${Object.keys(files).length}-file payload (${(bytes/1e6).toFixed(1)}MB), delivery, CORS, allowlist, date/24-venue/auth gates, newer replace: OK`);
