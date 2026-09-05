#!/usr/bin/env python3
"""
BOAT CHECK v31 collector
- BOAT RACE公式の当日開催・1R〜12Rを取得
- raceindex から開催節の日程（初日〜最終日）を取得
- 現在日の racelist から登録番号・支部・年齢を取得
- racer profile から登録期を取得し data/racers.json にキャッシュ
- 過去日分は raceindex からその節のレース一覧を同じJSON内に保持
"""
from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
BASE = "https://www.boatrace.jp"
INDEX_URL = BASE + "/owpc/pc/race/index"
RACEINDEX_URL = BASE + "/owpc/pc/race/raceindex"
RACELIST_URL = BASE + "/owpc/pc/race/racelist"
PROFILE_URL = BASE + "/owpc/pc/data/racersearch/profile"

VENUES = {
    "01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
    "07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
    "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
    "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
}

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; BOAT-CHECK/0.31; +https://github.com/golfclubnavi/boat-check)",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
})

def compact(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def get_soup(url: str, params: dict, timeout: int = 20) -> BeautifulSoup:
    r = session.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return BeautifulSoup(r.text, "html.parser")

def active_venues(date: str) -> list[tuple[str, str]]:
    soup = get_soup(INDEX_URL, {"hd": date})
    found = {}
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        m = re.search(r"(?:[?&]|&amp;)jcd=(\d{2})", href)
        if m and m.group(1) in VENUES:
            found[m.group(1)] = VENUES[m.group(1)]
    if not found:
        text = compact(soup.get_text(" ", strip=True))
        for code, name in VENUES.items():
            if name in text:
                found[code] = name
    return sorted(found.items())

def detect_grade(soup: BeautifulSoup, title: str) -> str:
    blob = " ".join(
        f"{k}={' '.join(map(str,v)) if isinstance(v,(list,tuple)) else v}"
        for tag in soup.find_all(True)
        for k,v in tag.attrs.items()
    ).lower()
    for grade, pat in [
        ("SG", r"(?:^|[_/\-.])sg(?:[_/\-.]|$)|grade[^a-z0-9]*sg"),
        ("G1", r"(?:^|[_/\-.])g1(?:[_/\-.]|$)|grade[^a-z0-9]*g1"),
        ("G2", r"(?:^|[_/\-.])g2(?:[_/\-.]|$)|grade[^a-z0-9]*g2"),
        ("G3", r"(?:^|[_/\-.])g3(?:[_/\-.]|$)|grade[^a-z0-9]*g3"),
    ]:
        if re.search(pat, blob, re.I):
            return grade
    t = compact(title)
    if re.search(r"(^|[^A-Z])SG([^A-Z]|$)", t, re.I): return "SG"
    if re.search(r"(^|[^A-Z])G1([^A-Z0-9]|$)", t, re.I) or re.search(r"開設.{0,8}周年記念", t): return "G1"
    if re.search(r"(^|[^A-Z])G2([^A-Z0-9]|$)", t, re.I) or "モーターボート大賞" in t: return "G2"
    if re.search(r"(^|[^A-Z])G3([^A-Z0-9]|$)", t, re.I) or re.search(r"オールレディース|マスターズリーグ", t): return "G3"
    return "一般"

def extract_title(soup: BeautifulSoup) -> str:
    for h in soup.find_all("h2"):
        t = compact(h.get_text(" ", strip=True))
        if t:
            return t
    return ""

def parse_races(soup: BeautifulSoup) -> list[dict]:
    races, seen = [], set()
    for tr in soup.find_all("tr"):
        text = compact(tr.get_text(" ", strip=True))
        m = re.search(r"(?:^|\s)(1[0-2]|[1-9])R\s+(\d{1,2}:\d{2})(?:\s|$)", text)
        if not m:
            continue
        rno, deadline = int(m.group(1)), m.group(2)
        if rno in seen:
            continue
        racers = []
        for name, klass in re.findall(
            r"([一-龥々ヶヵぁ-んァ-ヶー・　 ]{2,24}?)\s+(A1|A2|B1|B2)(?=\s|$)", text
        ):
            name = re.sub(r"[　\s]+", " ", name).strip()
            if name and len(name) <= 20:
                racers.append((name, klass))
        boats = [{"lane":i,"racerName":n,"class":c} for i,(n,c) in enumerate(racers[:6],1)]
        races.append({"raceNo":rno,"deadline":deadline,"boats":boats})
        seen.add(rno)
    return sorted(races, key=lambda x:x["raceNo"])

def day_label_from_text(text: str) -> str:
    m = re.search(r"(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)", text)
    return m.group(1) if m else ""

def infer_tab_date(href: str, fallback_year: int) -> str | None:
    try:
        q = parse_qs(urlparse(href.replace("&amp;","&")).query)
        hd = (q.get("hd") or [None])[0]
        if hd and re.fullmatch(r"\d{8}", hd):
            return hd
    except Exception:
        pass
    return None

def parse_meet_days(soup: BeautifulSoup, base_date: str) -> list[dict]:
    out, seen = [], set()

    # First choice: date-tab links with explicit hd=YYYYMMDD.
    for a in soup.find_all("a", href=True):
        text = compact(a.get_text(" ", strip=True))
        if not re.search(r"\d{1,2}月\d{1,2}日", text):
            continue
        if not re.search(r"初日|日目|最終日", text):
            continue
        hd = infer_tab_date(a.get("href",""), int(base_date[:4]))
        if hd and hd not in seen:
            out.append({"date":hd,"label":day_label_from_text(text),"day":day_label_from_text(text)})
            seen.add(hd)

    # Fallback: visible tab text; infer year around base date.
    if not out:
        text = compact(soup.get_text(" ", strip=True))
        base_year, base_month = int(base_date[:4]), int(base_date[4:6])
        for mm, dd, label in re.findall(
            r"(\d{1,2})月(\d{1,2})日\s*(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)", text
        ):
            month = int(mm)
            year = base_year
            if base_month == 12 and month == 1: year += 1
            if base_month == 1 and month == 12: year -= 1
            hd = f"{year:04d}{month:02d}{int(dd):02d}"
            if hd not in seen:
                out.append({"date":hd,"label":label,"day":label})
                seen.add(hd)

    return sorted(out, key=lambda x:x["date"])

def parse_racelist_meta(soup: BeautifulSoup) -> list[dict]:
    """Current race page: registration no, class, branch and age."""
    found = []
    used = set()

    for a in soup.find_all("a", href=True):
        href = a.get("href","")
        mt = re.search(r"(?:[?&]|&amp;)toban=(\d{4})", href)
        if not mt:
            continue
        toban = mt.group(1)
        if toban in used:
            continue
        row = a.find_parent("tr")
        text = compact((row or a.parent or a).get_text(" ", strip=True))

        klass = ""
        mk = re.search(rf"{re.escape(toban)}\s*/\s*(A1|A2|B1|B2)", text)
        if mk: klass = mk.group(1)

        name = compact(a.get_text(" ", strip=True))
        if not name or name == toban or len(name) > 24:
            mn = re.search(rf"{re.escape(toban)}\s*/\s*(?:A1|A2|B1|B2)\s+(.+?)\s+[^\s/]+/[^\s/]+\s+\d{{1,2}}歳/", text)
            name = compact(mn.group(1)) if mn else ""

        branch = ""
        mb = re.search(r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳/", text)
        age = None
        if mb:
            branch = mb.group(1)
            age = int(mb.group(3))

        found.append({
            "racerId":toban,
            "racerName":name,
            "class":klass,
            "branch":branch,
            "age":age,
        })
        used.add(toban)
        if len(found) == 6:
            break

    # HTML structure fallback based on official rendered text.
    if len(found) < 6:
        text = compact(soup.get_text(" ", strip=True))
        pat = re.compile(
            r"(\d{4})\s*/\s*(A1|A2|B1|B2)\s+(.{2,24}?)\s+"
            r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳/"
        )
        found = []
        for toban, klass, name, branch, _origin, age in pat.findall(text):
            if toban in {x["racerId"] for x in found}: continue
            found.append({
                "racerId":toban,
                "racerName":compact(name),
                "class":klass,
                "branch":branch,
                "age":int(age),
            })
            if len(found)==6: break
    return found

def enrich_current_races(code: str, date: str, races: list[dict]) -> set[str]:
    racer_ids = set()
    for r in races:
        try:
            soup = get_soup(RACELIST_URL, {"rno":r["raceNo"],"jcd":code,"hd":date})
            meta = parse_racelist_meta(soup)
            if len(meta) == 6:
                r["boats"] = [
                    {"lane":i, **b}
                    for i,b in enumerate(meta,1)
                ]
                racer_ids.update(b["racerId"] for b in meta if b.get("racerId"))
        except Exception as e:
            r["metaError"] = f"{type(e).__name__}: {e}"
        time.sleep(0.04)
    return racer_ids

def load_racer_cache(path: Path) -> dict:
    try:
        if path.exists():
            d = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(d, dict): return d
    except Exception:
        pass
    return {}

def fetch_profile_period(toban: str) -> tuple[str, dict]:
    try:
        r = requests.get(
            PROFILE_URL,
            params={"toban":toban},
            headers=session.headers,
            timeout=12,
        )
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "utf-8"
        text = compact(BeautifulSoup(r.text,"html.parser").get_text(" ", strip=True))
        mp = re.search(r"登録期\s*(\d+)期", text)
        return toban, {
            "period": int(mp.group(1)) if mp else None,
            "updatedAt": datetime.now(JST).isoformat(timespec="seconds")
        }
    except Exception as e:
        return toban, {"period":None,"error":f"{type(e).__name__}: {e}"}

def fill_periods(meetings: list[dict], cache_path: Path):
    cache = load_racer_cache(cache_path)
    ids = {
        b.get("racerId")
        for m in meetings
        for r in m.get("races",[])
        for b in r.get("boats",[])
        if b.get("racerId")
    }
    missing = sorted(x for x in ids if x not in cache or not cache[x].get("period"))

    if missing:
        print(f"[BOAT CHECK] racer period cache misses={len(missing)}")
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = [ex.submit(fetch_profile_period, x) for x in missing]
            for fut in as_completed(futs):
                toban, info = fut.result()
                cache[toban] = info

    for m in meetings:
        for r in m.get("races",[]):
            for b in r.get("boats",[]):
                info = cache.get(b.get("racerId",""),{})
                if info.get("period"):
                    b["period"] = info["period"]

        for d in m.get("meetDays",[]):
            if d.get("date") == m.get("date"):
                # current day points at enriched races below
                d["races"] = m.get("races",[])
            else:
                for r in d.get("races",[]):
                    for b in r.get("boats",[]):
                        # past-day base raceindex lacks racerId, so period stays unavailable.
                        pass

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")

def collect_venue(code: str, date: str, deep: bool) -> dict | None:
    soup = get_soup(RACEINDEX_URL, {"hd":date,"jcd":code})
    races = parse_races(soup)
    if not races: return None

    title = extract_title(soup)
    text = compact(soup.get_text(" ", strip=True))
    day = day_label_from_text(text)
    meet_days = parse_meet_days(soup,date)

    # Load past/current meet days. Future days remain as tabs with no fabricated races.
    for d in meet_days:
        if d["date"] == date:
            d["races"] = races
        elif d["date"] < date:
            try:
                psoup = get_soup(RACEINDEX_URL, {"hd":d["date"],"jcd":code})
                d["races"] = parse_races(psoup)
            except Exception:
                d["races"] = []
            time.sleep(0.05)
        else:
            d["races"] = []

    item = {
        "venueCode":code,
        "venueName":VENUES[code],
        "date":date,
        "title":title,
        "grade":detect_grade(soup,title),
        "day":day,
        "status":"open",
        "races":races,
        "meetDays":meet_days or [{"date":date,"label":day,"day":day,"races":races}],
    }

    if deep:
        enrich_current_races(code,date,item["races"])
        for d in item["meetDays"]:
            if d["date"] == date:
                d["races"] = item["races"]
    return item

def collect(date: str, deep: bool, cache_path: Path) -> dict:
    venues = active_venues(date)
    print(f"[BOAT CHECK] date={date} active candidates={len(venues)} deep={deep}")
    meetings, errors = [], []

    for code,name in venues:
        try:
            item = collect_venue(code,date,deep)
            if item:
                meetings.append(item)
                print(f"  OK {code} {name}: {len(item['races'])} races / {len(item.get('meetDays',[]))} days")
            else:
                print(f"  SKIP {code} {name}: race rows not found")
        except Exception as e:
            errors.append({"venueCode":code,"venueName":name,"error":f"{type(e).__name__}: {e}"})
            print(f"  ERROR {code} {name}: {e}")
        time.sleep(0.08)

    if deep and meetings:
        fill_periods(meetings,cache_path)

    return {
        "schemaVersion":"31.0",
        "updatedAt":datetime.now(JST).isoformat(timespec="seconds"),
        "dateJST":date,
        "source":"BOAT RACE official public pages",
        "meetings":meetings,
        "errors":errors,
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--date",default=None,help="YYYYMMDD。省略時は日本時間の今日")
    p.add_argument("--out",default="data/today.json")
    p.add_argument("--deep",action="store_true",help="racelist/profileまで取得")
    args=p.parse_args()

    date=args.date or datetime.now(JST).strftime("%Y%m%d")
    out=Path(args.out)
    cache_path=out.parent/"racers.json"
    payload=collect(date,args.deep,cache_path)

    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"[BOAT CHECK] collected {len(payload['meetings'])} meetings -> {out}")

    if not payload["meetings"]:
        raise SystemExit("No meetings collected.")

if __name__=="__main__":
    main()
