#!/usr/bin/env python3
"""Aggregate venue x entry-course results from the cached official result files.

Reuses the archives that collect_course_stats.py already downloaded into the
Actions cache; this script never contacts the official site.  When coverage is
too low it writes nothing, so the previously published file stays in place.
"""
import argparse
import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean

from collect_course_stats import VENUES, decode_archive, parse_day, subtract_months

MOVES=('逃げ','差し','まくり','まくり差し','抜き','恵まれ')
PERIODS=(('y1',12),('m3',3))
MIN_COVERAGE=.8


def started(row):
    # K = absent before the race; every other code (1-6, F, L, S) left the pit.
    return not str(row['finish']).startswith('K') and row['finish']!='欠'


def summarize(rows):
    races=defaultdict(list)
    for r in rows:races[(r['date'],r['venueCode'],r['raceNo'])].append(r)
    decided=[rs for rs in races.values() if any(r['finish']==1 for r in rs)]
    out={'races':len(decided),'courses':{},'kimarite':{},'grades':{}}
    for c in range(1,7):
        sample=[r for r in rows if r['course']==c and started(r)]
        n=len(sample)
        pct=lambda k:round(k*100/n,1) if n else None
        sts=[r['normalST'] for r in sample if r.get('normalST') is not None]
        out['courses'][str(c)]={'starts':n,'win':pct(sum(r['finish']==1 for r in sample)),
            'top2':pct(sum(r['finish'] in (1,2) for r in sample)),'top3':pct(sum(r['finish'] in (1,2,3) for r in sample)),
            'avgST':round(mean(sts),3) if sts else None}
    for move in MOVES:
        out['kimarite'][move]=sum(1 for rs in decided if rs[0]['raceMove']==move)
    for rs in decided:out['grades'][rs[0]['grade']]=out['grades'].get(rs[0]['grade'],0)+1
    return out


def aggregate(rows,base):
    result={}
    for period,months in PERIODS:
        start=subtract_months(base,months).isoformat()
        window=[r for r in rows if start<=r['date']<base.isoformat()]
        by_venue=defaultdict(list)
        for r in window:by_venue[r['venueCode']].append(r)
        result[period]={'from':start,'to':(base-timedelta(days=1)).isoformat(),'national':summarize(window),
                        'venues':{code:summarize(by_venue[code]) for code in sorted(by_venue)}}
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--input',default='data/today.json');p.add_argument('--cache',default='.cache/course-results')
    p.add_argument('--out',default='data/venue-stats.json');args=p.parse_args()
    base=datetime.strptime(json.loads(Path(args.input).read_text())['dateJST'],'%Y%m%d').date()
    first=subtract_months(base,12)
    days=[first+timedelta(days=i) for i in range((base-first).days)]
    rows=[];collected=0;errors=[]
    for day in days:
        path=Path(args.cache)/f'k{day:%y%m%d}.lzh'
        if not path.exists():continue
        try:parsed=parse_day(decode_archive(path.read_bytes()),day,None)
        except Exception as exc:errors.append({'date':day.isoformat(),'error':type(exc).__name__});continue
        collected+=1
        for racer_rows in parsed.values():rows.extend(racer_rows)
    if collected<len(days)*MIN_COVERAGE:
        print(f'::warning title=Venue statistics skipped::{collected}/{len(days)} cached days; keep the published file')
        return
    out={'schemaVersion':1,'targetDateJST':base.strftime('%Y%m%d'),'source':'BOAT RACE official result download files',
         'daysExpected':len(days),'daysCollected':collected,'errors':errors,'venueNames':VENUES,
         'periods':aggregate(rows,base),'generatedAt':datetime.now().astimezone().isoformat(timespec='seconds')}
    path=Path(args.out);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')))
    y1=out['periods']['y1']
    print(f"[venue] days={collected}/{len(days)} races={y1['national']['races']} venues={len(y1['venues'])}")


if __name__=='__main__':main()
