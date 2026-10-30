#!/usr/bin/env python3
"""Run one or more bounded LIVE rounds without overlapping official requests."""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from build_public_data import build

def run(*args):subprocess.run((sys.executable,)+args,check=True)

def minutes_since_live_commit():
    subprocess.run(('git','fetch','origin','main'),check=False,capture_output=True)
    out=subprocess.run(('git','log','-1','--format=%ct','--grep=^Refresh BOAT CHECK live data$','origin/main'),capture_output=True,text=True).stdout.strip()
    return (time.time()-int(out))/60 if out else float('inf')

def edge_only_round(every):
    """Serve this round from the LIVE Worker only, keeping git commits to one per `every` minutes.

    Opt-in via LIVE_GIT_EVERY_MINUTES; without a configured edge endpoint or when the
    upload fails, the round is published to git exactly as before.
    """
    if not every or not (os.environ.get('CF_LIVE_URL') and os.environ.get('CF_LIVE_TOKEN')):return False
    if minutes_since_live_commit()>=every:return False
    build(Path('data/today.json'),Path('data'))
    if subprocess.run((sys.executable,'scripts/upload_live.py')).returncode==0:
        print(f'[live-window] edge updated; git commit deferred (every {every} min)',flush=True);return True
    print('::warning title=Edge upload failed::Publishing this round to git instead',flush=True);return False

def main():
    p=argparse.ArgumentParser();p.add_argument('--rounds',type=int,default=1);p.add_argument('--interval',type=int,default=120);args=p.parse_args()
    if not 1<=args.rounds<=3 or args.interval<120:raise SystemExit('Require 1–3 rounds and interval >=120s')
    start=time.monotonic();finished=0
    for index in range(args.rounds):
        target=max(start+index*args.interval,finished+15 if index else start)
        while time.monotonic()<target:time.sleep(min(30,target-time.monotonic()))
        began=time.monotonic()
        print(f'[live-window] round={index+1}/{args.rounds}',flush=True)
        options=['--refresh-only'] if index else []
        run('scripts/collect_today.py','--live','--out','data/today.json','--workers','8',*options)
        run('scripts/check_data_quality.py')
        if not edge_only_round(int(os.environ.get('LIVE_GIT_EVERY_MINUTES') or 0)):
            run('scripts/publish_data.py','--mode','live','--message','Refresh BOAT CHECK live data','data/today.json')
            # Build and publish merged views before optionally serving them from KV.
            result=subprocess.run((sys.executable,'scripts/upload_live.py'))
            if result.returncode:print('::warning title=Edge upload failed::Static release retained; inspect LIVE endpoint settings',flush=True)
        finished=time.monotonic()
        duration=finished-began
        print(f'[live-window] roundSeconds={duration:.1f}',flush=True)
        if duration>180:print('::warning title=Slow LIVE collection::Target 1–3 minute freshness is not achieved',flush=True)

if __name__=='__main__':main()
