// Cron-driven trigger for the LIVE workflow. GitHub's own */5 schedule fires only
// every 2-6 hours, so Cloudflare's cron calls workflow_dispatch instead.
// It only starts the existing workflow; it never touches data or the official site.
const API='https://api.github.com';

export function jstMinutes(date){
  const d=new Date(date.getTime()+9*3600000);
  return d.getUTCHours()*60+d.getUTCMinutes();
}

// Default window covers morning races (first deadline about 08:30) to
// midnight races (last deadline about 21:00) plus result publication.
export function shouldDispatch(date,env){
  const now=jstMinutes(date);
  const [sh,sm]=(env.WINDOW_START||'08:00').split(':').map(Number);
  const [eh,em]=(env.WINDOW_END||'21:45').split(':').map(Number);
  if(now<sh*60+sm||now>eh*60+em)return false;
  const every=Math.max(5,Number(env.EVERY_MINUTES||15));
  return now%every<5;
}

export async function dispatch(env,fetcher=fetch){
  if(!env.GITHUB_TOKEN||!env.REPOSITORY)throw new Error('GITHUB_TOKEN and REPOSITORY are required');
  const response=await fetcher(`${API}/repos/${env.REPOSITORY}/actions/workflows/${env.WORKFLOW||'update-data.yml'}/dispatches`,{
    method:'POST',
    headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'boat-check-dispatch'},
    body:JSON.stringify({ref:env.REF||'main'})
  });
  // 204 is success; the workflow's concurrency group keeps runs from overlapping.
  if(response.status!==204)throw new Error(`dispatch failed: HTTP ${response.status}`);
  return true;
}

export default {
  async scheduled(event,env,ctx){
    if(env.ENABLED!=='true')return;
    const at=new Date(event.scheduledTime);
    if(!shouldDispatch(at,env))return;
    ctx.waitUntil(dispatch(env).then(()=>console.log('[dispatch] started',at.toISOString())));
  },
  async fetch(){return new Response('Not found',{status:404});}
};
