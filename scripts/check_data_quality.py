#!/usr/bin/env python3
"""Action annotations for missing or stale public race data."""
import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

p=argparse.ArgumentParser();p.add_argument('--input',default='data/today.json');args=p.parse_args()
d=json.loads(Path(args.input).read_text(encoding='utf-8'))
meetings=d.get('meetings') or []
races=[r for m in meetings for r in m.get('races',[])]
boats=[b for r in races for b in r.get('boats',[])]
racers={str(b.get('racerId') or b.get('registrationNo')) for b in boats if b.get('racerId') or b.get('registrationNo')}
print(f"[quality] date={d.get('dateJST')} generated={d.get('updatedAt')} venues={len(meetings)} races={len(races)} racers={len(racers)} boats={len(boats)} errors={len(d.get('errors') or [])}")
for field in ('period','branch','avgST','motorTwoRate','boatTwoRate'):
    present=sum(b.get(field) not in (None,'') for b in boats)
    rate=present/len(boats) if boats else 0
    print(f'[quality] {field}={present}/{len(boats)} ({rate:.1%})')
    if boats and rate<.8:print(f'::warning title=Low racer data coverage::{field} {rate:.1%}')
for field in ('odds','beforeData','result'):
    count=sum(bool(r.get(field)) for r in races)
    print(f'[quality] {field}={count}/{len(races)}')
for kind in ('trifecta','trio','exacta','quinella','wide','win','place'):
    print(f'[quality] odds.{kind}={sum(bool((r.get("odds") or {}).get(kind)) for r in races)}/{len(races)}')
unknown=[m for m in meetings if m.get('grade') not in ('SG','G1','G2','G3','一般') or not m.get('gradeVerified')]
print(f'[quality] unknownGrade={len(unknown)}')
for m in unknown:print(f"::warning title=Unknown grade::{m.get('venueName')}: {m.get('title')}")
for name in ('course-stats','entry-details'):
    try:
        extra=json.loads(Path(f'data/{name}.json').read_text(encoding='utf-8'))
        covered=len(racers.intersection((extra.get('byRacer') or {}).keys()))
        print(f'[quality] {name} racers={covered}/{len(racers)} to={extra.get("to")}')
        if racers and covered/len(racers)<.8:print(f'::warning title=Supplemental coverage::{name} {covered}/{len(racers)}')
    except (OSError,ValueError):print(f'::warning title=Supplemental file missing::{name}')
now=datetime.now(ZoneInfo('Asia/Tokyo'))
try:
    age=(now-datetime.fromisoformat(d['updatedAt'])).total_seconds()/60
    if age>20:print(f'::warning title=Stale snapshot::generated {age:.0f} minutes ago')
except (KeyError,ValueError,TypeError):print('::warning title=Missing timestamp::updatedAt invalid')
if not meetings or not races or not boats:raise SystemExit('Empty collection; refusing publication')
