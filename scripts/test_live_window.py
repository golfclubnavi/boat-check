#!/usr/bin/env python3
"""Offline checks for the opt-in edge-only LIVE round (no network, temporary repos)."""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import run_live_window as w


def git(cwd,*args,env=None):
    return subprocess.run(('git',)+args,cwd=cwd,check=True,capture_output=True,text=True,env={**os.environ,**(env or {})})


def main():
    with tempfile.TemporaryDirectory() as tmp:
        origin=Path(tmp)/'origin.git';work=Path(tmp)/'work'
        git(tmp,'init','-q','--bare','-b','main',str(origin));git(tmp,'clone','-q',str(origin),str(work))
        for k,v in (('user.name','t'),('user.email','t@t')):git(work,'config',k,v)
        cwd=os.getcwd();os.chdir(work)
        try:
            assert w.minutes_since_live_commit()==float('inf'),'no history yet'
            old={'GIT_COMMITTER_DATE':'2026-01-01T00:00:00+09:00'}
            git(work,'commit','-q','--allow-empty','-m','Refresh BOAT CHECK live data',env=old);git(work,'push','-q','origin','HEAD:main')
            assert w.minutes_since_live_commit()>60
            git(work,'commit','-q','--allow-empty','-m','Refresh adjacent BOAT CHECK dates');git(work,'push','-q','origin','HEAD:main')
            assert w.minutes_since_live_commit()>60,'other job commits do not count'
            git(work,'commit','-q','--allow-empty','-m','Refresh BOAT CHECK live data');git(work,'push','-q','origin','HEAD:main')
            assert w.minutes_since_live_commit()<5
        finally:os.chdir(cwd)

        # Branching without real uploads: record what would run.
        built=[];uploads=[]
        w.build=lambda src,dst:built.append(str(src))
        result={'code':0}
        real_run=w.subprocess.run
        def fake_run(args,*a,**k):
            if args[-1]=='scripts/upload_live.py':uploads.append(1);return subprocess.CompletedProcess(args,result['code'])
            return real_run(args,*a,**k)
        w.subprocess.run=fake_run
        os.environ.pop('CF_LIVE_URL',None);os.environ.pop('CF_LIVE_TOKEN',None)
        w.minutes_since_live_commit=lambda:1
        assert w.edge_only_round(60) is False and not built,'no edge configured: unchanged git path'
        os.environ.update(CF_LIVE_URL='https://edge.test',CF_LIVE_TOKEN='x')
        assert w.edge_only_round(0) is False and not built,'opt-in only'
        assert w.edge_only_round(60) is True and built and uploads,'recent git commit: edge only'
        result['code']=1
        assert w.edge_only_round(60) is False,'failed upload falls back to git'
        w.minutes_since_live_commit=lambda:61
        built.clear()
        assert w.edge_only_round(60) is False and not built,'interval elapsed: commit to git'
    print('[live-window] opt-in gate, edge-only round, upload failure fallback, commit interval, other-job commits ignored: OK')


if __name__=='__main__':main()
