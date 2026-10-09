#!/usr/bin/env python3
"""Create small public views from the canonical collector snapshot.

Never infer a missing value. The original today.json remains a recovery/source
artifact, but is not requested by the browser on its initial page load.
"""
import argparse
import json
from pathlib import Path


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def build(source, destination):
    data=json.loads(source.read_text(encoding='utf-8'))
    today=data.get('dateJST')
    if not today or not isinstance(data.get('meetings'), list):
        raise ValueError('Invalid current-day snapshot; refusing to publish empty views')
    summaries=[]
    venue_files=[]
    for meeting in data['meetings']:
        code=str(meeting.get('venueCode') or '').zfill(2)
        if not code.isdigit() or len(code)!=2 or not (1<=int(code)<=24):
            raise ValueError(f'Invalid venue code: {code}')
        summary={k:v for k,v in meeting.items() if k not in ('races','meetDays')}
        summary['races']=[]
        for race in meeting.get('races', []):
            short={k:race[k] for k in ('raceNo','deadline','status','statusLabel','note') if k in race}
            short['boats']=[{k:b[k] for k in ('lane','racerId','registrationNo','racerName','class','branch','period') if k in b}
                            for b in race.get('boats', [])]
            summary['races'].append(short)
        summaries.append(summary)
        venue_file=destination/'venue'/f'{code}.json'
        write(venue_file, meeting)
        venue_files.append(venue_file)
        live={k:meeting[k] for k in ('venueCode','date','status','statusLabel','meetDataLiveUpdatedAt') if k in meeting}
        live['updatedAt']=data.get('updatedAt')
        live['races']=[]
        for race in meeting.get('races',[]):
            dynamic={k:race[k] for k in ('raceNo','deadline','status','statusLabel','odds','oddsUpdatedAt',
                     'oddsLastAttemptAt','beforeData','startExhibition','beforeUpdatedAt','weather',
                     'result','resultUpdatedAt','resultLastAttemptAt','resultWeather','liveErrors') if k in race}
            dynamic['boats']=[{k:b[k] for k in ('lane','racerId','registrationNo','before','weight',
                              'weightAdjustment','exhibitionTime','tilt','partsExchange',
                              'exhibitionCourse','course','exhibitionST','startExhibitionST',
                              'actualCourse','actualST','finish','rank') if k in b}
                              for b in race.get('boats',[])]
            live['races'].append(dynamic)
        live_file=destination/'venue-live'/f'{code}.json'
        write(live_file,live)
        venue_files.append(live_file)

    home={k:data[k] for k in ('schemaVersion','dateJST','updatedAt','errors') if k in data}
    home['meetings']=summaries
    all_races=[r for m in data['meetings'] for r in m.get('races',[])]
    home['dailyOverview']={
        'venues':len(data['meetings']),
        'ended':sum(bool((r.get('result') or {}).get('official')) for r in all_races),
        'exhibition':sum(len(r.get('beforeData') or [])==6 for r in all_races),
        'strongWind':sum(float((r.get('weather') or {}).get('windSpeed') or 0)>=6 for r in all_races),
        'courseChanges':sum(any(int(b.get('exhibitionCourse') or b.get('course') or b.get('lane') or 0)!=int(b.get('lane') or 0) for b in r.get('boats',[]))
                            for r in all_races if r.get('startExhibition')),
    }
    write(destination/'home-live.json',home)
    settlements={k:data[k] for k in ('dateJST','updatedAt') if k in data}
    settlements['recentResults']=data.get('recentResults',[])
    write(destination/'settlements.json',settlements)
    home_bytes=(destination/'home-live.json').stat().st_size
    settlement_bytes=(destination/'settlements.json').stat().st_size
    print(f'[views] date={today} home={home_bytes} bytes, '
          f'venues={len(venue_files)}, settlements={settlement_bytes} bytes')
    return [destination/'home-live.json',destination/'settlements.json',*venue_files]


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',default='data/today.json')
    parser.add_argument('--outdir',default='data')
    args=parser.parse_args()
    build(Path(args.input),Path(args.outdir))
