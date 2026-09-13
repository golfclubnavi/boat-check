#!/usr/bin/env python3
"""Collect annual racer appearances and current-generation official motor data."""
import argparse,json,re,unicodedata
from pathlib import Path
from datetime import date,datetime,timedelta,timezone
from concurrent.futures import ThreadPoolExecutor,as_completed
from collections import defaultdict
import requests
from bs4 import BeautifulSoup
import collect_course_stats as history

MOTOR_URLS={
 '04':'https://www.heiwajima.gr.jp/01motor/01motor.htm',
 '06':'https://www.boatrace-hamanako.jp/modules/datafile/',
 '07':'https://www.gamagori-kyotei.com/asp/gamagori/kyogi/kyogihtml/contents/01history/01history_motor0703.htm',
 '08':'https://www.boatrace-tokoname.jp/modules/datafile/',
 '09':'https://www.boatrace-tsu.com/modules/datafile/?page=index_motorrank',
 '10':'https://www.boatrace-mikuni.jp/modules/datafile/',
 '11':'https://www.boatrace-biwako.jp/modules/datafile/?page=index_motorrank',
 '12':'https://www.boatrace-suminoe.jp/asp/suminoe/contents/01history/ranking_motor.php',
 '18':'https://www.boatrace-tokuyama.jp/modules/datafile/',
 '19':'https://www.boatrace-shimonoseki.jp/modules/datafile/',
 '20':'https://www.wmb.jp/modules/datafile/',
 '21':'https://www.boatrace-ashiya.com/modules/datafile/',
 '22':'https://www.boatrace-fukuoka.com/modules/datafile/?page=index_mrankdtl',
}
def text(node):
 return unicodedata.normalize('NFKC',node.get_text(' ',strip=True))
def compact(value):return re.sub(r'\s+','',value)
def number(value):
 m=re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)%?',compact(value))
 return float(m[1]) if m else None
def jpdate(match):return date(*map(int,match.groups()[:3])).isoformat()
def parse_motors(html,code,url):
 soup=BeautifulSoup(html,'html.parser');full=text(soup)
 start=re.search(r'使用開始\s*[:：]?\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日',full)
 begin=jpdate(start) if start else None
 to=None;out={}
 if code=='04':
  match=re.search(r'優勝集計[^0-9]*(\d{4})年(\d{1,2})月(\d{1,2})日[~～](\d{4})年(\d{1,2})月(\d{1,2})日',full)
  if match:
   begin=date(*map(int,match.groups()[:3])).isoformat();to=date(*map(int,match.groups()[3:])).isoformat()
 if code=='07':
  m=re.search(r'データ集計[:：]?\s*(\d{4})/(\d{1,2})/(\d{1,2})\s*[~～]\s*(?:(\d{4})/)?\s*(\d{1,2})/\s*(\d{1,2})',full)
  if m:
   begin=date(int(m[1]),int(m[2]),int(m[3])).isoformat();to=date(int(m[4] or m[1]),int(m[5]),int(m[6])).isoformat()
  for tr in soup.select('table.ta_rank tr'):
   cells=[text(x) for x in tr.find_all('td',recursive=False)]
   if len(cells)!=14:continue
   vals=[number(x) for x in cells]
   if vals[1] is None:continue
   out[str(int(vals[1]))]={'motorNo':int(vals[1]),'rank':vals[0],'starts':vals[2],'winRate':vals[3],'twoRate':vals[5],'finalistCount':vals[11],'championships':vals[12]}
 else:
  best={};best_to=to
  for table in soup.select('table'):
   if table.find_parent('table'):continue
   rows=table.find_all('tr');header=next((tr for tr in rows if tr.find_all('th',recursive=False)),None)
   if not header:continue
   names=[compact(text(x)).replace('▼','') for x in header.find_all('th',recursive=False)]
   aliases={'motorNo':['モーター番号','機番'],'rank':['順位'],'winRate':['勝率'],'twoRate':['2連対率','2連率','2連率(モーター)'],'threeRate':['3連対率','3連率'],'starts':['出走回数','出走数'],'finalistCount':['優出回数','優出'],'championships':['優勝回数','優勝'],'firstCount':['1着'],'secondCount':['2着'],'thirdCount':['3着']}
   mapping={k:next((i for i,n in enumerate(names) if n in candidates),None) for k,candidates in aliases.items()}
   if mapping['motorNo'] is None or mapping['twoRate'] is None:continue
   out={}
   # Remove hidden modal histories and select options from preceding text.
   prefix=BeautifulSoup(str(soup).split(str(table),1)[0],'html.parser')
   for node in prefix.select('option,script,style'):node.decompose()
   dates=list(re.finditer(r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:終了時点|時点|以前)',text(prefix)))
   if dates:to=jpdate(dates[-1])
   for tr in rows:
    if tr.find_parent('table') is not table:continue
    cells=tr.find_all('td',recursive=False)
    if len(cells)!=len(names):continue
    motor_cell=cells[mapping['motorNo']]
    link=motor_cell.select_one('a')
    raw=text(link) if link else text(motor_cell)
    no=number(raw)
    if no is None:continue
    item={'motorNo':int(no)}
    for key,i in mapping.items():
     if i is not None and key!='motorNo':
      value=number(text(cells[i]))
      if value is not None:item[key]=value
    n=item.get('starts')
    if n:
     if 'firstCount' in item:item['firstRate']=round(100*item['firstCount']/n,2)
     if all(k in item for k in ['firstCount','secondCount','thirdCount']):item['threeRate']=round(100*sum(item[k] for k in ['firstCount','secondCount','thirdCount'])/n,2)
    out[str(int(no))]=item
   if out and (not best or (to or "")>(best_to or "")):
    best=out;best_to=to
  out=best;to=best_to
 if not out:raise ValueError('No verified motor table rows')
 # If date cannot be verified, publish source data with no historical aggregation.
 for item in out.values():item.update({'sourceUrl':url,'usageStart':begin,'asOf':to,'rankBasis':'勝率' if code=='07' else '2連対率','source':'official_venue'})
 return out

def enrich_history(motor,rows,days_ok):
 start,end=motor.get('usageStart'),motor.get('asOf')
 if not start or not end:return
 first,last=date.fromisoformat(start),date.fromisoformat(end)
 if any((first+timedelta(days=i)).isoformat() not in days_ok for i in range((last-first).days+1)):return
 rows=[r for r in rows if start<=r['date']<=end and not str(r['finish']).startswith('K')]
 rows.sort(key=lambda r:(r['date'],r['raceNo']),reverse=True)
 if not rows:return
 n=len(rows);motor['historyStarts']=n
 motor.setdefault('starts',n)
 motor.setdefault('firstRate',round(100*sum(r['finish']==1 for r in rows)/n,2))
 motor['kimarite']={key:{'count':sum(r['finish']==1 and r['raceMove']==name for r in rows),'rate':round(100*sum(r['finish']==1 and r['raceMove']==name for r in rows)/n,2)} for key,name in [('escape','逃げ'),('sashi','差し'),('makuri','まくり'),('makuriSashi','まくり差し')]}
 motor['recent20']=[{k:r[k] for k in ['date','raceNo','registrationNo','racerName','course','exhibitionTime','finish']} for r in rows[:20]]
 motor['historySource']='BOAT RACE official results; same motor usage period'

def main():
 p=argparse.ArgumentParser();p.add_argument('--input',default='data/today.json');p.add_argument('--out',default='data/entry-details.json');p.add_argument('--cache',default='.cache/entry-results');p.add_argument('--workers',type=int,default=6);p.add_argument('--motor-fixtures');args=p.parse_args()
 payload=json.loads(Path(args.input).read_text());base=datetime.strptime(payload['dateJST'],'%Y%m%d').date();first=history.subtract_months(base,12);wanted=history.current_racers(payload)
 motors={};errors=[]
 def motor_task(pair):
  code,url=pair
  if args.motor_fixtures:
   name={'07':'gm','09':'tsu'}.get(code,'motor-'+code);html=(Path(args.motor_fixtures)/(name+'.html')).read_text()
  else:
   r=requests.get(url,headers=history.HEADERS,timeout=25);r.raise_for_status();r.encoding=r.apparent_encoding;html=r.text
  return code,parse_motors(html,code,url)
 with ThreadPoolExecutor(max_workers=4) as ex:
  futs={ex.submit(motor_task,pair):pair[0] for pair in MOTOR_URLS.items()}
  for f in as_completed(futs):
   try:code,data=f.result();motors[code]=data
   except Exception as e:errors.append({'venueCode':futs[f],'kind':'motor','error':str(e)[:200]})
 print('Official motor tables:',len(motors),'venues',flush=True)
 cache=Path(args.cache);cache.mkdir(parents=True,exist_ok=True);days=[first+timedelta(days=i) for i in range((base-first).days)];racer_rows=defaultdict(list);motor_rows=defaultdict(list);days_ok=set()
 def task(day):
  path=cache/f'k{day:%y%m%d}.lzh'
  if path.exists():blob=path.read_bytes()
  else:
   _,blob,err=history.download_day(day,25)
   if not blob:raise ValueError(err)
   history.decode_archive(blob);path.write_bytes(blob)
  parsed=history.parse_day(history.decode_archive(blob),day,None)
  return day,parsed
 with ThreadPoolExecutor(max_workers=args.workers) as ex:
  futs={ex.submit(task,d):d for d in days}
  for i,f in enumerate(as_completed(futs),1):
   try:
    day,parsed=f.result();days_ok.add(day.isoformat())
    for rid,rows in parsed.items():
     if rid in wanted:racer_rows[rid].extend(rows)
     for r in rows:
      code,no=r['venueCode'],str(r['motorNo']);motor=motors.get(code,{}).get(no)
      if motor and motor.get('usageStart') and motor.get('asOf') and motor['usageStart']<=r['date']<=motor['asOf']:motor_rows[(code,no)].append(r)
   except Exception as e:errors.append({'date':futs[f].isoformat(),'kind':'archive','error':str(e)[:200]})
   if i%60==0:print('History',i,'/',len(days),flush=True)
 if len(days_ok)<len(days)*.95:raise RuntimeError('Insufficient archive coverage; keeping previous output')
 overall={rid:history.aggregate_overall(rows,base) for rid,rows in racer_rows.items()}
 for code,by_no in motors.items():
  for no,motor in by_no.items():enrich_history(motor,motor_rows[(code,no)],days_ok)
 out={'schemaVersion':1,'targetDateJST':payload['dateJST'],'from':first.isoformat(),'to':(base-timedelta(days=1)).isoformat(),'generatedAt':datetime.now(timezone.utc).isoformat(),'daysCollected':len(days_ok),'daysExpected':len(days),'errors':errors,'byRacer':overall,'motorsByVenue':motors,'unavailable':['期間別勝率','F休み開始日','F未消化数','事故率','未提供の足評価・中間整備','モーター過去走の当時級別']}
 path=Path(args.out);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')))
 print(json.dumps({'racers':len(overall),'motorVenues':len(motors),'motors':sum(map(len,motors.values())),'days':len(days_ok),'errors':errors},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
