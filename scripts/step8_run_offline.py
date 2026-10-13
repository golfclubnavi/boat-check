#!/usr/bin/env python3
"""Build and offline-test only a disposable copy; never publish or collect."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--logs',type=Path,required=True);args=p.parse_args()
src=args.source.resolve();logs=args.logs.resolve()
if logs==src or src in logs.parents:raise SystemExit('Logs must be outside protected source')
logs.mkdir(parents=True,exist_ok=True)
def manifest():
    return {str(f.relative_to(src)):hashlib.sha256(f.read_bytes()).hexdigest() for f in src.rglob('*') if f.is_file() and '.git' not in f.relative_to(src).parts}
before=manifest();results=[]
try:
    with tempfile.TemporaryDirectory(prefix='boatcheck-step8-ci-') as temp:
        copy=Path(temp)/'source';shutil.copytree(src,copy,ignore=shutil.ignore_patterns('.git'))
        def run(name,command):
            result=subprocess.run(command,cwd=copy,capture_output=True,text=True,timeout=240)
            (logs/(name+'.log')).write_text(result.stdout+result.stderr)
            results.append({'test':name,'exit':result.returncode})
            print(name,'exit',result.returncode)
            if result.returncode:raise RuntimeError(name+' failed; see isolated log')
        run('collector-offline-12',['python3','scripts/test_live_recovery.py'])
        run('current-day-offline-4',['node','scripts/test_current_day.cjs'])
        run('release-build',['bash','cloudflare-build.sh'])
        snapshot=json.loads((copy/'data/today.json').read_text())
        stamp=snapshot['updatedAt'];test=copy/'scripts/test_app.cjs';text=test.read_text()
        marker='const ctx=vm.createContext(sandbox);'
        if marker not in text:raise RuntimeError('DOM wrapper injection marker changed')
        clock="sandbox.Date=class extends Date { constructor(...a){super(...(a.length?a:[STAMP]));} static now(){return Date.parse(STAMP);} };\n".replace('STAMP',json.dumps(stamp))
        test.write_text(text.replace(marker,clock+marker,1))
        run('dom-frozen-snapshot',['node','scripts/test_app.cjs'])
        run('optional-worker',['node','scripts/test_worker.mjs'])
finally:
    intact=before==manifest()
    (logs/'summary.json').write_text(json.dumps({'tests':results,'sourceUnchanged':intact,'snapshotClockOnly':'DOM stub; no iPhone/real-time proof','worker':'Optional test may SKIP; Worker not verified'},indent=2))
    if not intact:raise RuntimeError('Protected source changed')
print('OFFLINE PASS; source unchanged; no collection/publication performed')
