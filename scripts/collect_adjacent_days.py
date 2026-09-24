#!/usr/bin/env python3
"""Fetch separate day snapshots; never replace the live today.json payload."""
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from collect_today import (JST, VENUES, active_venues, collect_venue_fast,
                           fetch_racelist_task, fetch_result_task, load_json)


def collect_day(day, today, directory):
    venues = active_venues(day)
    if not venues:
        return {'dateJST': day, 'updatedAt': datetime.now(JST).isoformat(),
                'available': False, 'meetings': [], 'errors': [],
                'note': 'No confirmed race cards published yet'}
    cache = load_json(directory / 'racers.json', {})
    meetings, errors = [], []
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(collect_venue_fast, code, day, {}, cache): code for code, _ in venues}
        for future in as_completed(jobs):
            code = jobs[future]
            try:
                m = future.result()
                if m:
                    meetings.append(m)
                else:
                    errors.append({'venueCode': code, 'error': 'race card not published'})
            except Exception as exc:
                errors.append({'venueCode': code, 'error': str(exc)[:180]})
    if not meetings:
        if any(e['error'] != 'race card not published' for e in errors):
            raise RuntimeError(f'{day}: all requests failed; keeping previous snapshot')
        return {'dateJST': day, 'updatedAt': datetime.now(JST).isoformat(),
                'available': False, 'meetings': [], 'errors': errors,
                'note': 'Race cards not published yet'}
    races = {(m['venueCode'], r['raceNo']): r for m in meetings for r in m.get('races', [])}
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = [pool.submit(fetch_racelist_task, code, day, no) for code, no in races]
        for future in as_completed(jobs):
            code, no, boats, error = future.result()
            if boats:
                races[code, no]['boats'] = boats
            if error:
                errors.append({'venueCode': code, 'raceNo': no, 'kind': 'entry', 'error': error})
        if day < today:
            jobs = [pool.submit(fetch_result_task, code, day, no) for code, no in races]
            for future in as_completed(jobs):
                code, no, result, error = future.result()
                if result:
                    races[code, no]['result'] = result
                if error:
                    errors.append({'venueCode': code, 'raceNo': no, 'kind': 'result', 'error': error})
    return {'dateJST': day, 'updatedAt': datetime.now(JST).isoformat(),
            'meetings': sorted(meetings, key=lambda m: m['venueCode']),
            'errors': errors, 'source': 'BOAT RACE official date-specific race pages'}


def main():
    directory = Path('data')
    today = datetime.now(JST)
    failures = []
    for offset, filename in [(-1, 'yesterday.json'), (1, 'tomorrow.json')]:
        day = (today + timedelta(days=offset)).strftime('%Y%m%d')
        try:
            payload = collect_day(day, today.strftime('%Y%m%d'), directory)
            path = directory / filename
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            temporary.replace(path)
            print(filename, day, len(payload['meetings']), 'venues', len(payload['errors']), 'errors')
        except Exception as exc:
            failures.append(f'{filename}: {exc}')
    if failures:
        raise SystemExit('\n'.join(failures))


if __name__ == '__main__':
    main()
