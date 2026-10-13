#!/usr/bin/env python3
"""Two fixed official-page GETs; checks accessibility, not full parser recovery."""
import argparse
import datetime
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--logs',type=Path,required=True);args=p.parse_args()
date=os.environ.get('SMOKE_DATE','');venue=os.environ.get('SMOKE_VENUE','');race=os.environ.get('SMOKE_RACE','')
if not re.fullmatch(r'\d{8}',date) or not re.fullmatch(r'\d{2}',venue) or not re.fullmatch(r'\d{1,2}',race):raise SystemExit('Invalid date/venue/race')
datetime.datetime.strptime(date,'%Y%m%d')
if not 1<=int(venue)<=24 or not 1<=int(race)<=12:raise SystemExit('Venue/race out of range')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k):return None
opener=urllib.request.build_opener(NoRedirect);rows=[]
for page in ('beforeinfo','odds3t'):
    url='https://www.boatrace.jp/owpc/pc/race/'+page+'?'+urllib.parse.urlencode({'hd':date,'jcd':venue,'rno':race})
    req=urllib.request.Request(url,headers={'User-Agent':'BOAT-CHECK-STEP8-public-smoke/1.0'})
    with opener.open(req,timeout=20) as response:
        raw=response.read(2_000_001)
        if len(raw)>2_000_000:raise SystemExit('Response too large')
        rows.append({'page':page,'status':response.status,'bytes':len(raw),'date':date,'venue':venue,'race':int(race)})
args.logs.mkdir(parents=True,exist_ok=True);(args.logs/'official-smoke.json').write_text(json.dumps({'requests':rows,'scope':'Accessibility only; no parsed values or stored race data'},indent=2))
print('Official accessibility smoke: two GETs complete; parser/data completeness unverified')
