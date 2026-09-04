#!/usr/bin/env python3
"""
BOAT CHECK v19 - fast collector
BOAT RACE公式の公開レースページから当日の開催場・1R〜12R・締切・6艇の基本情報を収集。
24場を少数並列で取得し、GitHub Actionsの長時間実行・重複実行を避ける。
"""
from __future__ import annotations

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

VENUES = {
    "01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
    "07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
    "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
    "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
}
BASE = "https://www.boatrace.jp/owpc/pc/race/"
UA = "BOAT-CHECK/0.19 (+personal project; low-concurrency collector)"
TIMEOUT = 8

def fetch(path: str, **params) -> str:
    url = BASE + path + "?" + urlencode(params)
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "ja,en;q=0.8",
        "Cache-Control": "no-cache",
    })
    with urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")

def clean(html: str) -> str:
    html = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&nbsp;", " ").replace("&#39;", "'").replace("&amp;", "&")
    return re.sub(r"\s+", " ", html).strip()

def parse_raceindex(html: str):
    text = clean(html)
    races = []
    for rno in range(1, 13):
        next_r = rno + 1
        end_pat = rf"(?=\s{next_r}R\s+\d{{1,2}}:\d{{2}}|$)" if rno < 12 else r"$"
        m = re.search(
            rf"(?:^|\s){rno}R\s+(\d{{1,2}}:\d{{2}})([\s\S]*?){end_pat}",
            text
        )
        if not m:
            continue
        deadline, chunk = m.group(1), m.group(2)
        racers = re.findall(r"([一-龥々ヶぁ-んァ-ヶー\s]{2,20})\s+(A1|A2|B1|B2)", chunk)
        boats = []
        for lane, (name, klass) in enumerate(racers[:6], 1):
            boats.append({
                "lane": lane,
                "racerName": re.sub(r"\s+", " ", name).strip(),
                "class": klass
            })
        races.append({
            "raceNo": rno,
            "deadline": deadline,
            "boats": boats
        })
    return races

def collect_venue(code: str, name: str, date: str):
    try:
        html = fetch("raceindex", hd=date, jcd=code)
        races = parse_raceindex(html)
        if not races:
            return None
        return {
            "venueCode": code,
            "venueName": name,
            "date": date,
            "status": "open",
            "races": races
        }
    except Exception as e:
        return {
            "venueCode": code,
            "venueName": name,
            "date": date,
            "status": "fetch_error",
            "fetchError": type(e).__name__,
            "races": []
        }

def collect(date: str):
    meetings = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {
            ex.submit(collect_venue, code, name, date): code
            for code, name in VENUES.items()
        }
        for fut in as_completed(futures):
            item = fut.result()
            if item and item.get("races"):
                meetings.append(item)

    meetings.sort(key=lambda x: x["venueCode"])
    return {
        "schemaVersion": "19.0",
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": "BOAT RACE official public raceindex pages",
        "mode": "fast",
        "meetings": meetings
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--out", default="data/today.json")
    args = ap.parse_args()

    payload = collect(args.date)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Collected {len(payload['meetings'])} active venues -> {out}")

if __name__ == "__main__":
    main()
