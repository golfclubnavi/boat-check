#!/usr/bin/env python3
"""
BOAT CHECK v20 collector
- GitHub Actions上でも日本時間(Asia/Tokyo)の日付を使用
- BOAT RACE公式「本日のレース」から開催場を特定
- 各開催場の raceindex から1R〜12R、締切予定時刻、6艇の選手名/級別を取得
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
BASE = "https://www.boatrace.jp"
INDEX_URL = BASE + "/owpc/pc/race/index"
RACEINDEX_URL = BASE + "/owpc/pc/race/raceindex"

VENUES = {
    "01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
    "07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
    "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
    "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
}
NAME_TO_CODE = {v: k for k, v in VENUES.items()}

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; BOAT-CHECK/0.20; +https://github.com/golfclubnavi/boat-check)",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
})

def get_soup(url: str, params: dict) -> BeautifulSoup:
    r = session.get(url, params=params, timeout=20)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return BeautifulSoup(r.text, "html.parser")

def compact(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def active_venues(date: str) -> list[tuple[str, str]]:
    """公式の当日一覧にある開催場コードをリンクから取得。"""
    soup = get_soup(INDEX_URL, {"hd": date})
    found = {}

    # jcd=XX を含むレース系リンクから開催場を拾う
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        m = re.search(r"(?:[?&]|&amp;)jcd=(\d{2})", href)
        if not m:
            continue
        code = m.group(1)
        if code in VENUES:
            found[code] = VENUES[code]

    # HTML構造変更時のフォールバック：本文に場名があるものを拾う
    if not found:
        text = compact(soup.get_text(" ", strip=True))
        for code, name in VENUES.items():
            if name in text:
                found[code] = name

    return sorted(found.items())

def page_meta(soup: BeautifulSoup, date: str, code: str) -> dict:
    text = compact(soup.get_text(" ", strip=True))
    title = ""
    h2 = soup.find(["h1", "h2"])
    if h2:
        title = compact(h2.get_text(" ", strip=True))

    day = ""
    # 9月5日３日目 / 9月5日最終日 のような表記を優先
    md = re.search(r"\d{1,2}月\d{1,2}日\s*(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)", text)
    if md:
        day = md.group(1)

    return {
        "venueCode": code,
        "venueName": VENUES[code],
        "date": date,
        "title": title,
        "day": day,
    }

def parse_races(soup: BeautifulSoup) -> list[dict]:
    races = []
    seen = set()

    # raceindex の各レース行を、tr単位で構造に依存しすぎず抽出
    for tr in soup.find_all("tr"):
        text = compact(tr.get_text(" ", strip=True))
        m = re.search(r"(?:^|\s)(1[0-2]|[1-9])R\s+(\d{1,2}:\d{2})(?:\s|$)", text)
        if not m:
            continue

        rno = int(m.group(1))
        deadline = m.group(2)
        if rno in seen:
            continue

        # 行内の「氏名 A1/A2/B1/B2」を抽出
        racers = []
        for name, klass in re.findall(
            r"([一-龥々ヶヵぁ-んァ-ヶー・　 ]{2,24}?)\s+(A1|A2|B1|B2)(?=\s|$)",
            text
        ):
            name = re.sub(r"[　\s]+", " ", name).strip()
            # 見出し等の誤検出を除外
            if name and len(name) <= 20:
                racers.append((name, klass))

        # 重複を保ったまま先頭6艇
        boats = [
            {"lane": i, "racerName": n, "class": c}
            for i, (n, c) in enumerate(racers[:6], 1)
        ]

        races.append({
            "raceNo": rno,
            "deadline": deadline,
            "boats": boats,
        })
        seen.add(rno)

    return sorted(races, key=lambda x: x["raceNo"])

def collect_venue(code: str, date: str) -> dict | None:
    soup = get_soup(RACEINDEX_URL, {"hd": date, "jcd": code})
    races = parse_races(soup)
    if not races:
        return None
    item = page_meta(soup, date, code)
    item["status"] = "open"
    item["races"] = races
    return item

def collect(date: str) -> dict:
    venues = active_venues(date)
    print(f"[BOAT CHECK] date={date} active candidates={len(venues)}")

    meetings = []
    errors = []
    for code, name in venues:
        try:
            item = collect_venue(code, date)
            if item:
                meetings.append(item)
                print(f"  OK {code} {name}: {len(item['races'])} races")
            else:
                print(f"  SKIP {code} {name}: race rows not found")
        except Exception as e:
            errors.append({"venueCode": code, "venueName": name, "error": f"{type(e).__name__}: {e}"})
            print(f"  ERROR {code} {name}: {e}")
        time.sleep(0.15)

    return {
        "schemaVersion": "20.0",
        "updatedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "dateJST": date,
        "source": "BOAT RACE official public pages",
        "meetings": meetings,
        "errors": errors,
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=None, help="YYYYMMDD。省略時は日本時間の今日")
    parser.add_argument("--out", default="data/today.json")
    args = parser.parse_args()

    date = args.date or datetime.now(JST).strftime("%Y%m%d")
    payload = collect(date)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[BOAT CHECK] collected {len(payload['meetings'])} meetings -> {out}")
    if not payload["meetings"]:
        raise SystemExit("No meetings collected. today.json was written for diagnostics, but collection is treated as failure.")

if __name__ == "__main__":
    main()
