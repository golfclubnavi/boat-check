#!/usr/bin/env python3
"""Collect 2-point conduct violations from official venue race-card PDFs."""
import argparse,hashlib,json,re,subprocess,tempfile,unicodedata
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import date,datetime,timezone
from pathlib import Path
from urllib.parse import urljoin,urlparse
import requests
from bs4 import BeautifulSoup

VENUE_BASES={
 '01':'https://www.kiryu-kyotei.com','02':'https://www.boatrace-toda.jp','03':'https://www.boatrace-edogawa.com',
 '04':'https://www.heiwajima.gr.jp','05':'https://www.boatrace-tamagawa.com','06':'https://www.boatrace-hamanako.jp',
 '07':'https://www.gamagori-kyotei.com','08':'https://www.boatrace-tokoname.jp','09':'https://www.boatrace-tsu.com',
 '10':'https://www.boatrace-mikuni.jp','11':'https://www.boatrace-biwako.jp','12':'https://www.boatrace-suminoe.jp',
 '13':'https://www.boatrace-amagasaki.jp','14':'https://www.n14.jp','15':'https://www.marugameboat.jp',
 '16':'https://www.kojimaboat.jp','17':'https://www.boatrace-miyajima.com','18':'https://www.boatrace-tokuyama.jp',
 '19':'https://www.boatrace-shimonoseki.jp','20':'https://www.wmb.jp','21':'https://www.boatrace-ashiya.com',
 '22':'https://www.boatrace-fukuoka.com','23':'https://www.boatrace-karatsu.jp','24':'https://www.boatrace-omura.jp'}
HEADERS={'User-Agent':'Mozilla/5.0 (compatible; BOAT-CHECK/official-program-reader)','Accept-Language':'ja-JP,ja;q=0.9'}
DAY_LABELS={'初日':0,'1日目':0,'二日目':1,'2日目':1,'三日目':2,'3日目':2,'四日目':3,'4日目':3,'五日目':4,'5日目':4,'六日目':5,'6日目':5,'七日目':6,'7日目':6,'最終日':99}
REASON_POINTS={'不良航法':2,'待機行動違反':2,'待機行動実施細則違反':2}
PDF_INDEX_PAGES={
 '02':['/race/shusso_list.html'],
 '04':['/sp/s_pdf/s_pdf.htm'],
 '12':['/sp/s_pdf/s_pdf.htm'],
}

def compact(value):return re.sub(r'\s+','',unicodedata.normalize('NFKC',value or ''))

def meeting_dates(meeting):
 result={}
 days=meeting.get('meetDays',[]) or []
 for i,item in enumerate(days):
  raw=str(item.get('date') or '')
  if re.fullmatch(r'\d{8}',raw):result[compact(item.get('label') or item.get('day') or '')]=date(int(raw[:4]),int(raw[4:6]),int(raw[6:])).isoformat();result[str(i)]=result[compact(item.get('label') or item.get('day') or '')]
 return result

def likely_links(html,page_url,day):
 soup=BeautifulSoup(html,'html.parser');host=urlparse(page_url).netloc;found=[]
 for a in soup.select('a[href]'):
  href=a.get('href','');label=compact(a.get_text(' ',strip=True));url=urljoin(page_url,href)
  if urlparse(url).netloc!=host:continue
  key=(label+' '+url).lower()
  if '.pdf' in key:found.append((0 if day.strftime('%Y%m%d') in key else 1,url,'pdf'))
  elif any(x in key for x in ['出走表pdf','raceinfo-pdf','syussou','syutsuba','racecard']):found.append((2,url,'page'))
 return sorted(set(found))

def discover_pdfs(code,day):
 base=VENUE_BASES[code];queue=[base,base+'/sp/index.php?page=raceinfo-pdf']+[base+x for x in PDF_INDEX_PAGES.get(code,[])];seen=set();pdfs=[]
 for depth in range(3):
  next_queue=[]
  for page in queue[:12]:
   if page in seen:continue
   seen.add(page)
   try:
    r=requests.get(page,headers=HEADERS,timeout=18);r.raise_for_status()
   except Exception:continue
   ctype=r.headers.get('content-type','').lower()
   if 'pdf' in ctype or page.lower().split('?')[0].endswith('.pdf'):pdfs.append(page);continue
   for _,url,kind in likely_links(r.text,page,day):
    if kind=='pdf':pdfs.append(url)
    elif url not in seen:next_queue.append(url)
  if pdfs:break
  queue=next_queue
 if not pdfs:raise ValueError('official race-card PDF not discovered')
 dated=[u for u in pdfs if day.strftime('%Y%m%d') in u or day.strftime('%y%m%d') in u]
 candidates=dated or pdfs
 # Most venue sites publish several same-day PDFs.  The third race-card sheet
 # is normally the one containing the meeting-wide deduction notice.  Prefer
 # it, but verify the document text below instead of trusting a filename.
 def priority(url):
  path=urlparse(url).path.lower()
  return (0 if re.search(r'(?:_|/)0?3(?:_|\.)',path) else 1,
          0 if 'syussou' in path else 1,url)
 return sorted(set(candidates),key=priority)

def pdf_text(blob):
 with tempfile.TemporaryDirectory() as td:
  src=Path(td)/'program.pdf';out=Path(td)/'program.txt';src.write_bytes(blob)
  subprocess.run(['pdftotext','-layout',str(src),str(out)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  return out.read_text(errors='replace')

def parse_conduct_events(text,code,meeting,source_url):
 dates=meeting_dates(meeting);events=[];carry=''
 name_to_id={}
 for races in [meeting.get('races',[]) or []]+[d.get('races',[]) or [] for d in meeting.get('meetDays',[]) or []]:
  for race in races:
   for boat in race.get('boats',[]) or []:
    rid=str(boat.get('racerId') or boat.get('registrationNo') or '')
    name=compact(boat.get('racerName') or boat.get('name') or '')
    if rid and name:name_to_id[name]=rid
 # Notices are in the header before the first race.  Keeping this bounded
 # avoids matching explanatory text elsewhere in a program.
 header=text
 for line in header.splitlines():
  clean=unicodedata.normalize('NFKC',line)
  # The notice is the leftmost column; ignore day labels belonging to the
  # maintenance and ranking columns printed farther right on the same row.
  label_match=re.search(r'(初\s*日|[二三四五六七]\s*日\s*目|[1-7]\s*日\s*目|最\s*終\s*日)',clean[:70])
  if label_match:carry=compact(label_match.group(1))
  if not any(reason in clean for reason in REASON_POINTS):continue
  reason_pattern='不良航法|待機行動(?:実施細則)?違反'
  matches=[]
  for m in re.finditer(rf'(\d{{4}})\s+([^()（）\d]{{1,24}})\s*[（(]\s*({reason_pattern})\s*[）)]',clean):
   matches.append(m.groups())
  # Some official programs list a race, racer name, event-score deduction,
  # and reason but omit the registration number.  Resolve the exact name
  # only against entrants in today's official meeting data.
  for m in re.finditer(rf'(?:\d{{1,2}}R\s+)?([^\d－-]{{2,24}}?)\s*[－-]\s*\d+\s*点\s*({reason_pattern})',clean):
   raw_name,reason=m.groups();name=compact(raw_name).split('】')[-1]
   rid=name_to_id.get(name)
   if rid:matches.append((rid,name,reason))
  for rid,name,reason in matches:
   if reason=='待機行動実施細則違反':reason='待機行動違反'
   incident=dates.get(carry)
   if not incident and carry in DAY_LABELS:
    by_index=DAY_LABELS[carry];incident=dates.get(str(len(dates)//2-1 if by_index==99 else by_index))
   if not incident:incident=str(meeting.get('date') or '')
   if re.fullmatch(r'\d{8}',incident):incident=f'{incident[:4]}-{incident[4:6]}-{incident[6:]}'
   key=f'{incident}:{code}:{rid}:{reason}'
   events.append((key,{'date':incident,'venueCode':code,'racerId':rid,'racerName':compact(name),'reason':reason,'points':REASON_POINTS[reason],'sourceUrl':source_url}))
 return events

def collect_meeting(meeting,fixture=None):
 code=str(meeting['venueCode']).zfill(2);raw=str(meeting.get('date') or '')
 day=date(int(raw[:4]),int(raw[4:6]),int(raw[6:]))
 if fixture:
  blob=Path(fixture).read_bytes();url='fixture:'+Path(fixture).name
 else:
  rejected=[]
  for candidate in discover_pdfs(code,day):
   try:
    r=requests.get(candidate,headers=HEADERS,timeout=30);r.raise_for_status()
    blob=r.content;text=pdf_text(blob)
   except Exception as e:
    rejected.append(f'{candidate}: {e}');continue
   # A valid program keeps this heading even when there are no deductions.
   if '減点者' in compact(text):
    url=candidate;break
  else:
   raise ValueError('official deduction sheet not found among race-card PDFs')
  return code,url,hashlib.sha256(blob).hexdigest(),parse_conduct_events(text,code,meeting,url)
 return code,url,hashlib.sha256(blob).hexdigest(),parse_conduct_events(pdf_text(blob),code,meeting,url)

def main():
 p=argparse.ArgumentParser();p.add_argument('--input',default='data/today.json');p.add_argument('--ledger',default='data/accident-ledger.json');p.add_argument('--fixture');p.add_argument('--fixture-venue',default='08');args=p.parse_args()
 payload=json.loads(Path(args.input).read_text());path=Path(args.ledger);ledger=json.loads(path.read_text());meetings=[m for m in payload.get('meetings',[]) if m.get('status')!='closed']
 if args.fixture:meetings=[next(m for m in meetings if str(m.get('venueCode')).zfill(2)==args.fixture_venue.zfill(2))]
 errors=[];found=[]
 with ThreadPoolExecutor(max_workers=6) as ex:
  futs={ex.submit(collect_meeting,m,args.fixture):m for m in meetings}
  for f in as_completed(futs):
   m=futs[f]
   try:found.append(f.result())
   except Exception as e:errors.append({'venueCode':m.get('venueCode'),'error':str(e)[:240]})
 for code,url,digest,events in found:
  for key,event in events:ledger.setdefault('conductEvents',{}).setdefault(key,event)
 ledger['updatedAt']=datetime.now(timezone.utc).isoformat();ledger['collectionErrors']=errors
 programs=ledger.setdefault('lastPrograms',{})
 programs.update({code:{'sourceUrl':url,'sha256':digest} for code,url,digest,_ in found})
 path.write_text(json.dumps(ledger,ensure_ascii=False,separators=(',',':')))
 print(json.dumps({'programs':len(found),'eventsTotal':len(ledger.get('conductEvents',{})),'errors':errors},ensure_ascii=False))
if __name__=='__main__':main()
