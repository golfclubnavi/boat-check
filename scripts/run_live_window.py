#!/usr/bin/env python3
"""Three bounded LIVE rounds, with no overlapping official requests."""
import argparse
import subprocess
import sys
import time

def run(*args):subprocess.run((sys.executable,)+args,check=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('--rounds',type=int,default=3);p.add_argument('--interval',type=int,default=120);args=p.parse_args()
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
        run('scripts/publish_data.py','--mode','live','--message','Refresh BOAT CHECK live data','data/today.json')
        # Build and publish merged views before optionally serving them from KV.
        result=subprocess.run((sys.executable,'scripts/upload_live.py'))
        if result.returncode:print('::warning title=Edge upload failed::Static release retained; inspect LIVE endpoint settings',flush=True)
        finished=time.monotonic()
        duration=finished-began
        print(f'[live-window] roundSeconds={duration:.1f}',flush=True)
        if duration>180:print('::warning title=Slow LIVE collection::Target 1–3 minute freshness is not achieved',flush=True)

if __name__=='__main__':main()
