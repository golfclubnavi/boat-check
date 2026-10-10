// Functional runtime check against formal release files, not a visual browser test.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve('cloudflare-dist'),nodes=new Map(),store=new Map(),requests=[],errors=[];
function element(id){
 if(nodes.has(id))return nodes.get(id);
 const classes=new Set(id==='venue'||id==='detail'?['hidden']:[]);
 const node={id,innerHTML:'',textContent:'',hidden:false,value:'',dataset:{},style:{setProperty(){}},children:[],
  classList:{add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));},contains(x){return classes.has(x);},toggle(x,value){const on=value??!classes.has(x);on?classes.add(x):classes.delete(x);return on;}},
  addEventListener(){},setAttribute(){},removeAttribute(){},scrollIntoView(){},focus(){},appendChild(){},querySelector(){return null;},querySelectorAll(){return [];},getBoundingClientRect(){return {top:0,height:100,width:390,left:0};}};
 nodes.set(id,node);return node;
}
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
element('homeSnapshot').textContent=html.match(/id="homeSnapshot">([\s\S]*?)<\/script>/)[1];
const sandbox={console,URL,Intl,Date,Map,Set,JSON,Math,Number,String,Array,Object,Promise,RegExp,Error,AbortController,
 location:{pathname:'/boat-check/',search:'',hash:'',href:'https://boatcheck.jp/'},
 history:{replaceState(){},pushState(){}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
 document:{hidden:false,getElementById:element,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>element('created'),documentElement:element('html'),body:element('body')},
 setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},requestAnimationFrame:()=>0,
 alert(){},confirm:()=>true,scrollTo(){},scrollBy(){},addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}}),navigator:{},
 fetch:async url=>{const name=String(url).replace(/^\.\//,'').split('?')[0];requests.push(name);const file=path.join(root,name);if(!fs.existsSync(file))return {ok:false,status:404};return {ok:true,status:200,json:async()=>JSON.parse(fs.readFileSync(file,'utf8'))};}
};
sandbox.window=sandbox;
const ctx=vm.createContext(sandbox);
async function test(){
 for(const file of ['racer-notebook.js','live-config.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});
 await vm.runInContext('homeLoadPromise',ctx);
 assert(requests.includes('data/home-live.json'));
 assert(!requests.includes('data/today.json'));
 assert(!requests.includes('data/recent20.json'));
 assert.equal((element('venues').innerHTML.match(/class="card /g)||[]).length,24);
 assert(vm.runInContext('raceIsPast("12:00","12:00")',ctx));
 assert(!vm.runInContext('raceIsPast("12:00","11:59")',ctx));
 const codes=vm.runInContext('state.meetings.map(m=>m.venueCode)',ctx);
 for(const code of codes){
 await vm.runInContext(`openVenue('${code}')`,ctx);
 for(let no=1;no<=12;no++){
  vm.runInContext(`openRace(${no},false)`,ctx);
  assert.equal(vm.runInContext('state.currentRace.raceNo',ctx),no);
  for(const tab of ['racer','course','meet','motor','before','odds','result','replay','demo']){
   try{vm.runInContext(`showRaceData('${tab}')`,ctx);}
   catch(error){errors.push(`${no}R ${tab}: ${error.stack}`);}
  }
 }
 }
 await new Promise(resolve=>setImmediate(resolve));
 // In-progress venue data survives the next tiny-home refresh.
 await vm.runInContext('refreshOfficialData()',ctx);
 assert(vm.runInContext('state.currentRace.boats.length===6',ctx));
 assert(requests.includes(`data/venue-live/${codes.at(-1)}.json`));
 assert(!requests.includes('data/today.json'));
 if(errors.length)throw Error(errors.join('\n'));
 console.log(`[app] 24 cards, ${codes.length} venues × 12 races × 9 panels, lazy initial fetch, LIVE merge: OK`);
 console.log('[app] this DOM stub does not measure layout, LCP or touch behavior');
}
test().catch(error=>{console.error(error);process.exitCode=1;});
