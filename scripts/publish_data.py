#!/usr/bin/env python3
"""Publish independent Action jobs with optimistic main-branch retries.

The collector's output is retained in memory while main moves. A failed push
is retried against the new tip; it never rebases a stale canonical JSON commit.
"""
import argparse
import json
import subprocess
import time
from copy import deepcopy
from pathlib import Path

from build_public_data import build


def git(*args,check=True):
    return subprocess.run(('git',)+args,check=check,capture_output=True,text=True)


def newer(a,b):
    return bool(a and (not b or str(a)>str(b)))


def merge_today(latest,source,mode):
    if not latest or latest.get('dateJST')!=source.get('dateJST'):
        if latest and str(latest.get('dateJST',''))>str(source.get('dateJST','')):
            raise ValueError('A newer race date is already published')
        return source
    result=deepcopy(source if mode=='live' else latest)
    if mode=='live' and newer(latest.get('updatedAt'),source.get('updatedAt')):
        raise ValueError('A newer live snapshot is already published')
    fresh={m.get('venueCode'):m for m in source.get('meetings',[])}
    old={m.get('venueCode'):m for m in latest.get('meetings',[])}
    static_keys={'period','branch','origin','age','weight','avgST','meetStats','meetResults',
                 'nationalWinRate','national2Rate','national3Rate','localWinRate','local2Rate',
                 'local3Rate','motorNo','motorTwoRate','motorThreeRate','boatNo','boatTwoRate',
                 'boatThreeRate','motor','boat','stats'}
    for venue in result.get('meetings',[]):
        code=venue.get('venueCode')
        other=(old if mode=='live' else fresh).get(code)
        if not other:continue
        if mode=='live' and other.get('gradeVerified') and not venue.get('gradeVerified'):
            for k in ('grade','gradeVerified','gradeSource'):
                if k in other:venue[k]=other[k]
        if mode=='enrich':
            for k in ('grade','gradeVerified','gradeSource','meetDays','meetDataUpdatedAt'):
                if other.get(k) not in (None,'',[]):venue[k]=other[k]
        races={int(r.get('raceNo') or 0):r for r in other.get('races',[])}
        for race in venue.get('races',[]):
            prior=races.get(int(race.get('raceNo') or 0))
            if not prior:continue
            boats={int(b.get('lane') or 0):b for b in prior.get('boats',[])}
            for boat in race.get('boats',[]):
                ob=boats.get(int(boat.get('lane') or 0))
                if not ob or str(ob.get('racerId') or ob.get('registrationNo'))!=str(boat.get('racerId') or boat.get('registrationNo')):continue
                for k,v in ob.items():
                    if v in (None,'',[],{}):continue
                    if mode=='enrich' and k in static_keys:boat[k]=v
                    elif mode=='live' and (boat.get(k) in (None,'',[],{}) or (newer(latest.get('staticEnrichedAt'),source.get('staticEnrichedAt')) and k in static_keys)):boat[k]=v
            if mode=='enrich':
                for k in ('odds','oddsUpdatedAt','oddsLastAttemptAt','beforeData','startExhibition',
                          'beforeUpdatedAt','result','resultUpdatedAt','resultLastAttemptAt','weather'):
                    if k in race:continue
                    if k in prior:race[k]=prior[k]
            else:
                for stamp,keys in (('oddsUpdatedAt',('odds','oddsUpdatedAt')),
                                   ('beforeUpdatedAt',('beforeData','startExhibition','beforeUpdatedAt')),
                                   ('resultUpdatedAt',('result','resultUpdatedAt'))):
                    if newer(prior.get(stamp),race.get(stamp)):
                        for k in keys:
                            if k in prior:race[k]=prior[k]
    if mode=='enrich':
        result['staticEnrichedDate']=source.get('staticEnrichedDate')
        result['staticEnrichedAt']=source.get('staticEnrichedAt')
    elif newer(latest.get('staticEnrichedAt'),source.get('staticEnrichedAt')):
        result['staticEnrichedDate']=latest.get('staticEnrichedDate')
        result['staticEnrichedAt']=latest.get('staticEnrichedAt')
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--mode',choices=('live','enrich','files'),required=True)
    p.add_argument('--message',required=True)
    p.add_argument('files',nargs='+')
    args=p.parse_args()
    outputs={name:Path(name).read_bytes() for name in args.files}
    git('config','user.name','boat-check-bot')
    git('config','user.email','actions@users.noreply.github.com')
    for attempt in range(1,5):
        git('fetch','origin','main')
        current={}
        for name,blob in outputs.items():
            if name=='data/today.json' and args.mode in ('live','enrich'):
                prior=git('show','origin/main:'+name,check=False)
                try:latest=json.loads(prior.stdout) if prior.returncode==0 else {}
                except ValueError:latest={}
                try:current[name]=json.dumps(merge_today(latest,json.loads(blob),args.mode),ensure_ascii=False,indent=2).encode()
                except ValueError as error:
                    print(f'[publish] {error}; skip obsolete snapshot')
                    return
            else:current[name]=blob
        git('reset','--hard','origin/main')
        for name,blob in current.items():
            path=Path(name);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(blob)
        if 'data/today.json' in current:
            generated=build(Path('data/today.json'),Path('data'))
            subprocess.run(('node','scripts/add_static_home.js','.'),check=True)
            paths=list(current)+[str(path) for path in generated]+['index.html']
        else:paths=list(current)
        git('add',*paths)
        if 'data/today.json' in current:
            git('add','-u','data/venue','data/venue-live')
        if git('diff','--cached','--quiet',check=False).returncode==0:
            print('[publish] no changes');return
        git('commit','-m',args.message)
        push=git('push','origin','HEAD:main',check=False)
        if push.returncode==0:
            print(f'[publish] success on attempt {attempt}');return
        print(f'[publish] push collision or rejection (attempt {attempt}/4): {push.stderr[-500:]}')
        time.sleep(attempt*3)
    raise SystemExit('Unable to publish after four retries; inspect permissions and branch protection')


if __name__=='__main__':main()
