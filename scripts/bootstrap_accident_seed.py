#!/usr/bin/env python3
"""One-time bootstrap of current-period accident points from class2000 data."""
import argparse,json,re
from datetime import date,datetime,timezone
from pathlib import Path
import requests

SOURCE_PAGE='http://www.interq.or.jp/ito/kiida/kyotei/Class/class2000.html'
SOURCE_JS='http://www.interq.or.jp/ito/kiida/kyotei/ajs/tensu2000.js'
HEADERS={'User-Agent':'Mozilla/5.0 (compatible; BOAT-CHECK/accident-bootstrap)'}

def review_start(day):
 return date(day.year,5,1) if 5<=day.month<=10 else date(day.year if day.month>=11 else day.year-1,11,1)

def points_for_codes(codes):
 return sum(20 if c in 'FLUWX' else 15 if c=='x' else 10 if c in 'skubcde' else 2 if c in 'tr' else 0 for c in codes)

def parse_seed(raw):
 text=raw.decode('cp932','replace')
 m=re.search(r'var\s+YcurY=(\d+),\s*YcurM=(\d+),\s*YcurD=(\d+)',text)
 if not m:raise ValueError('Snapshot date not found')
 as_of=date(*map(int,m.groups()))
 players={}
 for rid,value in re.findall(r"yp\[(\d+)\]='([^']*)'",text):
  if len(value)<23:continue
  starts=int(value[21:23],16);codes=value[37:] if len(value)>37 else ''
  points=points_for_codes(codes)
  if not points:continue
  players[rid]={'seedStarts':starts,'seedPoints':points,'seedRate':round(points/starts,2) if starts else None,'accidentCodes':codes}
 ranked=sorted(players,key=lambda rid:(-(players[rid]['seedRate'] or 0),-players[rid]['seedPoints'],int(rid)))
 for rank,rid in enumerate(ranked,1):players[rid]['sourceRank']=rank
 return {'schemaVersion':1,'reviewPeriodStart':review_start(as_of).isoformat(),'seedAsOf':as_of.isoformat(),'seedSource':SOURCE_PAGE,'seedPlayerCount':len(players),'players':players,'conductEvents':{},'updatedAt':datetime.now(timezone.utc).isoformat(),'collectionErrors':[]}

def main():
 p=argparse.ArgumentParser();p.add_argument('--out',default='data/accident-ledger.json');p.add_argument('--fixture');args=p.parse_args()
 raw=Path(args.fixture).read_bytes() if args.fixture else requests.get(SOURCE_JS,headers=HEADERS,timeout=30).content
 data=parse_seed(raw)
 if data['seedPlayerCount']!=1214:raise RuntimeError(f"Expected 1214 racers with points, got {data['seedPlayerCount']}")
 out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')))
 print(json.dumps({k:data[k] for k in ['reviewPeriodStart','seedAsOf','seedPlayerCount']},ensure_ascii=False))
if __name__=='__main__':main()
