#!/usr/bin/env python3
"""
BOAT CHECK v37 collector

FAST（通常・30分ごと）
- BOAT RACE公式の当日開催場 + 各場raceindexだけを並列取得
- 締切/R/開催日/タイトル/グレードを更新
- 既存 today.json の選手詳細（登録番号・支部・期・年齢）を引き継ぐ
- 過去日の出走データも既存JSONから引き継ぐ
- racers.json の既存キャッシュを利用
- racelist / racer profile は毎回取りに行かない

ENRICH（別ワークフロー・1日1回/手動）
- 当日の全racelistを並列取得
- 支部・年齢・登録番号を更新
- racer profile は未取得の登録期だけ並列取得
- 過去開催日のraceindexも並列取得
"""
from __future__ import annotations

import argparse
import json
import re
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

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; BOAT-CHECK/0.37; +https://github.com/golfclubnavi/boat-check)",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
}

def compact(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def get_soup(url: str, params: dict, timeout: int = 18) -> BeautifulSoup:
    r = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return BeautifulSoup(r.text, "html.parser")

def load_json(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default

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


def detect_race_status(text: str) -> tuple[str, str]:
    t = compact(text)
    if re.search(r"中止順延|順延", t):
        return "postponed", "中止順延"
    if re.search(r"開催中止|レース中止|発売中止|不成立|中止", t):
        return "cancelled", "中止"
    return "", ""

def detect_meeting_status(text: str, races: list[dict]) -> tuple[str, str]:
    t = compact(text)
    if "中止順延" in t:
        return "postponed", "中止順延"
    if re.search(r"開催中止|全レース中止|中止打切|中止打ち切り|打ち切り", t):
        return "cancelled", "開催中止"
    if any(r.get("status") in ("cancelled","postponed") for r in races):
        return "partial_cancelled", "一部レース中止"
    return "open", ""

def parse_races(soup: BeautifulSoup) -> list[dict]:
    races, seen = [], set()
    for tr in soup.find_all("tr"):
        text = compact(tr.get_text(" ", strip=True))
        mr = re.search(r"(?:^|\s)(1[0-2]|[1-9])R(?:\s|$)", text)
        if not mr:
            continue
        rno = int(mr.group(1))
        if rno in seen:
            continue

        mt = re.search(r"(?:^|\s)(1[0-2]|[1-9])R\s+(\d{1,2}:\d{2})(?:\s|$)", text)
        deadline = mt.group(2) if mt else ""
        status, status_label = detect_race_status(text)

        if not deadline and not status:
            continue

        racers = []
        for name, klass in re.findall(
            r"([一-龥々ヶヵぁ-んァ-ヶー・　 ]{2,24}?)\s+(A1|A2|B1|B2)(?=\s|$)", text
        ):
            name = re.sub(r"[　\s]+", " ", name).strip()
            if name and len(name) <= 20:
                racers.append((name, klass))

        race = {
            "raceNo":rno,
            "deadline":deadline,
            "boats":[{"lane":i,"racerName":n,"class":c} for i,(n,c) in enumerate(racers[:6],1)]
        }
        if status:
            race["status"] = status
            race["statusLabel"] = status_label

        races.append(race)
        seen.add(rno)

    return sorted(races, key=lambda x:x["raceNo"])

def day_label_from_text(text: str) -> str:
    m = re.search(r"(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)", text)
    return m.group(1) if m else ""

def infer_tab_date(href: str) -> str | None:
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
    for a in soup.find_all("a", href=True):
        text = compact(a.get_text(" ", strip=True))
        if not re.search(r"\d{1,2}月\d{1,2}日", text): continue
        if not re.search(r"初日|日目|最終日", text): continue
        hd = infer_tab_date(a.get("href",""))
        if hd and hd not in seen:
            label = day_label_from_text(text)
            out.append({"date":hd,"label":label,"day":label})
            seen.add(hd)
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
    found, used = [], set()
    for a in soup.find_all("a", href=True):
        href = a.get("href","")
        mt = re.search(r"(?:[?&]|&amp;)toban=(\d{4})", href)
        if not mt: continue
        toban = mt.group(1)
        if toban in used: continue
        row = a.find_parent("tr")
        text = compact((row or a.parent or a).get_text(" ", strip=True))

        mk = re.search(rf"{re.escape(toban)}\s*/\s*(A1|A2|B1|B2)", text)
        klass = mk.group(1) if mk else ""

        name = compact(a.get_text(" ", strip=True))
        if not name or name == toban or len(name) > 24:
            mn = re.search(rf"{re.escape(toban)}\s*/\s*(?:A1|A2|B1|B2)\s+(.+?)\s+[^\s/]+/[^\s/]+\s+\d{{1,2}}歳/", text)
            name = compact(mn.group(1)) if mn else ""

        branch, age = "", None
        mb = re.search(r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳/", text)
        if mb:
            branch = mb.group(1)
            age = int(mb.group(3))

        found.append({"racerId":toban,"racerName":name,"class":klass,"branch":branch,"age":age})
        used.add(toban)
        if len(found) == 6: break

    if len(found) < 6:
        text = compact(soup.get_text(" ", strip=True))
        pat = re.compile(
            r"(\d{4})\s*/\s*(A1|A2|B1|B2)\s+(.{2,24}?)\s+"
            r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳/"
        )
        found = []
        used = set()
        for toban, klass, name, branch, _origin, age in pat.findall(text):
            if toban in used: continue
            found.append({
                "racerId":toban,"racerName":compact(name),"class":klass,
                "branch":branch,"age":int(age)
            })
            used.add(toban)
            if len(found)==6: break
    return found

def merge_boat_details(new_races: list[dict], old_races: list[dict], racer_cache: dict):
    old_by_race = {int(r.get("raceNo",0)): r for r in old_races or []}
    for r in new_races:
        old = old_by_race.get(int(r.get("raceNo",0)), {})
        old_boats = {int(b.get("lane",0)): b for b in old.get("boats",[])}

        for b in r.get("boats",[]):
            ob = old_boats.get(int(b.get("lane",0)), {})
            # 名前が変わっていない場合のみ詳細情報を継承
            same = not b.get("racerName") or not ob.get("racerName") or compact(b["racerName"]) == compact(ob["racerName"])
            if same:
                for key in ("racerId","branch","age","period"):
                    if ob.get(key) not in (None,""):
                        b[key] = ob[key]
            rid = b.get("racerId")
            if rid and racer_cache.get(str(rid),{}).get("period"):
                b["period"] = racer_cache[str(rid)]["period"]

def old_meeting_map(old_payload: dict) -> dict:
    return {
        str(m.get("venueCode")): m
        for m in old_payload.get("meetings",[])
        if m.get("venueCode")
    }

def collect_venue_fast(code: str, date: str, old_meeting: dict | None, racer_cache: dict) -> dict | None:
    soup = get_soup(RACEINDEX_URL, {"hd":date,"jcd":code})
    races = parse_races(soup)

    title = extract_title(soup)
    text = compact(soup.get_text(" ", strip=True))
    meeting_status, status_label = detect_meeting_status(text, races)

    if not races and meeting_status == "open":
        return None

    day = day_label_from_text(text)
    meet_days = parse_meet_days(soup,date)

    old_meeting = old_meeting or {}
    old_current = old_meeting.get("races",[]) if old_meeting.get("date") == date else []
    merge_boat_details(races, old_current, racer_cache)

    old_days = {
        d.get("date"): d for d in old_meeting.get("meetDays",[])
        if d.get("date")
    }

    if not meet_days:
        meet_days = [{"date":date,"label":day,"day":day}]

    for d in meet_days:
        if d["date"] == date:
            d["races"] = races
        else:
            old_d = old_days.get(d["date"],{})
            d["races"] = old_d.get("races",[]) if old_d else []

    return {
        "venueCode":code,
        "venueName":VENUES[code],
        "date":date,
        "title":title,
        "grade":detect_grade(soup,title),
        "day":day,
        "status":meeting_status,
        "statusLabel":status_label,
        "races":races,
        "meetDays":meet_days,
    }

def fetch_racelist_task(code: str, date: str, race_no: int):
    try:
        soup = get_soup(RACELIST_URL, {"rno":race_no,"jcd":code,"hd":date})
        return code, race_no, parse_racelist_meta(soup), None
    except Exception as e:
        return code, race_no, [], f"{type(e).__name__}: {e}"

def fetch_past_day_task(code: str, hd: str):
    try:
        soup = get_soup(RACEINDEX_URL, {"hd":hd,"jcd":code})
        return code, hd, parse_races(soup), None
    except Exception as e:
        return code, hd, [], f"{type(e).__name__}: {e}"

def fetch_profile_period(toban: str):
    try:
        soup = get_soup(PROFILE_URL, {"toban":toban}, timeout=14)
        text = compact(soup.get_text(" ", strip=True))
        mp = re.search(r"登録期\s*(\d+)期", text)
        return toban, {
            "period":int(mp.group(1)) if mp else None,
            "updatedAt":datetime.now(JST).isoformat(timespec="seconds")
        }
    except Exception as e:
        return toban, {"period":None,"error":f"{type(e).__name__}: {e}"}

def enrich_payload(payload: dict, cache_path: Path, workers: int = 10):
    meetings = payload.get("meetings",[])
    racer_cache = load_json(cache_path, {})

    # 全場×全Rのracelistをグローバル並列化
    tasks = []
    for m in meetings:
        code = m["venueCode"]
        for r in m.get("races",[]):
            tasks.append((code, m["date"], int(r["raceNo"])))

    print(f"[BOAT CHECK] ENRICH racelist tasks={len(tasks)} workers={workers}")
    meta_results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(fetch_racelist_task,*t) for t in tasks]
        for fut in as_completed(futs):
            code, rno, meta, err = fut.result()
            meta_results[(code,rno)] = (meta,err)

    for m in meetings:
        for r in m.get("races",[]):
            meta, err = meta_results.get((m["venueCode"],int(r["raceNo"])),([],None))
            if len(meta)==6:
                r["boats"] = [{"lane":i, **b} for i,b in enumerate(meta,1)]
            elif err:
                r["metaError"] = err

    # 過去開催日raceindexだけを並列取得（未来日は空のまま）
    past_tasks = []
    for m in meetings:
        for d in m.get("meetDays",[]):
            if d.get("date") and d["date"] < m["date"]:
                past_tasks.append((m["venueCode"],d["date"]))

    if past_tasks:
        print(f"[BOAT CHECK] ENRICH past-day tasks={len(past_tasks)}")
        past_results = {}
        with ThreadPoolExecutor(max_workers=min(workers,8)) as ex:
            futs = [ex.submit(fetch_past_day_task,*t) for t in past_tasks]
            for fut in as_completed(futs):
                code, hd, races, err = fut.result()
                past_results[(code,hd)] = (races,err)
        for m in meetings:
            for d in m.get("meetDays",[]):
                key=(m["venueCode"],d.get("date"))
                if key in past_results:
                    races,_ = past_results[key]
                    d["races"] = races

    # 現在日の出走表をmeetDaysにも反映
    for m in meetings:
        for d in m.get("meetDays",[]):
            if d.get("date") == m.get("date"):
                d["races"] = m.get("races",[])

    # 未取得の登録期だけprofile取得
    ids = {
        str(b.get("racerId"))
        for m in meetings for r in m.get("races",[]) for b in r.get("boats",[])
        if b.get("racerId")
    }
    missing = sorted(rid for rid in ids if not racer_cache.get(rid,{}).get("period"))
    print(f"[BOAT CHECK] ENRICH profile cache misses={len(missing)}")
    if missing:
        with ThreadPoolExecutor(max_workers=min(workers,10)) as ex:
            futs = [ex.submit(fetch_profile_period,rid) for rid in missing]
            for fut in as_completed(futs):
                rid, info = fut.result()
                racer_cache[rid] = info

    for m in meetings:
        for r in m.get("races",[]):
            for b in r.get("boats",[]):
                rid = str(b.get("racerId",""))
                p = racer_cache.get(rid,{}).get("period")
                if p:
                    b["period"] = p

    cache_path.parent.mkdir(parents=True,exist_ok=True)
    cache_path.write_text(json.dumps(racer_cache,ensure_ascii=False,indent=2),encoding="utf-8")

def collect(date: str, out_path: Path, enrich: bool, workers: int) -> dict:
    old_payload = load_json(out_path, {})
    racer_cache = load_json(out_path.parent/"racers.json", {})
    old_map = old_meeting_map(old_payload)

    venues = active_venues(date)
    print(f"[BOAT CHECK] date={date} active={len(venues)} mode={'ENRICH' if enrich else 'FAST'}")

    meetings, errors = [], []

    # 開催場の当日raceindexを並列化
    with ThreadPoolExecutor(max_workers=min(workers,8)) as ex:
        futs = {
            ex.submit(collect_venue_fast,code,date,old_map.get(code),racer_cache):(code,name)
            for code,name in venues
        }
        for fut in as_completed(futs):
            code,name=futs[fut]
            try:
                item=fut.result()
                if item:
                    meetings.append(item)
                    print(f"  OK {code} {name}: {len(item['races'])} races")
                else:
                    print(f"  SKIP {code} {name}: no race rows")
            except Exception as e:
                errors.append({"venueCode":code,"venueName":name,"error":f"{type(e).__name__}: {e}"})
                print(f"  ERROR {code} {name}: {e}")

    meetings.sort(key=lambda m:int(m["venueCode"]))

    payload = {
        "schemaVersion":"37.0",
        "updatedAt":datetime.now(JST).isoformat(timespec="seconds"),
        "dateJST":date,
        "source":"BOAT RACE official public pages",
        "mode":"enrich" if enrich else "fast",
        "meetings":meetings,
        "errors":errors,
    }

    if enrich and meetings:
        enrich_payload(payload,out_path.parent/"racers.json",workers=workers)

    return payload

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--date",default=None,help="YYYYMMDD。省略時は日本時間の今日")
    p.add_argument("--out",default="data/today.json")
    p.add_argument("--enrich",action="store_true",help="racelist/profile/過去日も取得")
    p.add_argument("--deep",action="store_true",help="旧互換: --enrich と同じ")
    p.add_argument("--workers",type=int,default=10)
    args=p.parse_args()

    date=args.date or datetime.now(JST).strftime("%Y%m%d")
    out_path=Path(args.out)
    enrich=bool(args.enrich or args.deep)

    payload=collect(date,out_path,enrich,args.workers)
    out_path.parent.mkdir(parents=True,exist_ok=True)
    out_path.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"[BOAT CHECK] collected {len(payload['meetings'])} meetings -> {out_path}")

    if not payload["meetings"]:
        raise SystemExit("No meetings collected.")

if __name__=="__main__":
    main()
