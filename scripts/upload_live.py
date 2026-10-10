#!/usr/bin/env python3
"""Optional edge upload; never embeds credentials in public files."""
import json
import os
import time
import urllib.request
from pathlib import Path

def upload():
    endpoint=os.environ.get('CF_LIVE_URL','').rstrip('/')
    token=os.environ.get('CF_LIVE_TOKEN','')
    if not endpoint or not token:
        print('[edge] not configured; committed views remain the public fallback');return
    if not endpoint.startswith('https://'):raise ValueError('LIVE endpoint must use HTTPS')
    files={}
    for name in ('home-live.json','settlements.json'):
        files[name]=json.loads((Path('data')/name).read_text())
    for folder in ('venue','venue-live'):
        for path in (Path('data')/folder).glob('*.json'):
            files[f'{folder}/{path.name}']=json.loads(path.read_text())
    body=json.dumps({'files':files},ensure_ascii=False,separators=(',',':')).encode()
    if len(body)>24_000_000:raise ValueError('LIVE upload exceeds configured limit')
    for attempt in range(3):
        try:
            request=urllib.request.Request(endpoint+'/ingest',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
            with urllib.request.urlopen(request,timeout=35) as response:
                result=json.load(response)
            if not result.get('ok'):raise ValueError('LIVE ingestion failed')
            print('[edge] upload accepted',files['home-live.json']['updatedAt']);return
        except Exception as error:
            if attempt==2:raise
            print('[edge] upload retry',type(error).__name__);time.sleep((attempt+1)*3)

if __name__=='__main__':upload()
