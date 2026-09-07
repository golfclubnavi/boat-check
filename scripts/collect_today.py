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
from datetime import datetime, timedelta
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
RESULTLIST_URL = BASE + "/owpc/pc/race/resultlist"
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
    """
    Extract full meeting schedule, including future dates.
    Handles:
    - linked day tabs
    - visible day/date cells
    - meeting date ranges such as 9/5～9/10
    """
    out: dict[str, dict] = {}
    base_dt = datetime.strptime(base_date, "%Y%m%d").date()
    base_year, base_month = base_dt.year, base_dt.month

    def resolve_date(month: int, day: int) -> str:
        year = base_year
        if base_month == 12 and month == 1:
            year += 1
        elif base_month == 1 and month == 12:
            year -= 1
        return f"{year:04d}{month:02d}{day:02d}"

    def add(hd: str | None, label: str):
        if not hd or not re.fullmatch(r"\d{8}", hd):
            return
        label = compact(label)
        if not label:
            return
        if hd not in out:
            out[hd] = {"date": hd, "label": label, "day": label}

    # 1) Explicit day links
    for a in soup.find_all("a", href=True):
        text = compact(a.get_text(" ", strip=True))
        label = day_label_from_text(text)
        if not label:
            continue
        hd = infer_tab_date(a.get("href", ""))
        if hd:
            add(hd, label)

        md = re.search(r"(\d{1,2})[月/](\d{1,2})日?", text)
        if md:
            add(resolve_date(int(md.group(1)), int(md.group(2))), label)

    # 2) Visible cells/buttons/spans
    for el in soup.find_all(["li", "td", "th", "button", "span", "div", "p"]):
        text = compact(el.get_text(" ", strip=True))
        if len(text) > 100:
            continue
        label = day_label_from_text(text)
        if not label:
            continue
        m = re.search(r"(?:(\d{4})[/-])?(\d{1,2})[月/-](\d{1,2})日?", text)
        if m:
            if m.group(1):
                hd = f"{int(m.group(1)):04d}{int(m.group(2)):02d}{int(m.group(3)):02d}"
            else:
                hd = resolve_date(int(m.group(2)), int(m.group(3)))
            add(hd, label)

    page_text = compact(soup.get_text(" ", strip=True))

    # 3) Page-text date+day-label fallback
    for pat in (
        r"(?:(\d{4})[/-])?(\d{1,2})月(\d{1,2})日\s*(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)",
        r"(?:(\d{4})[/-])?(\d{1,2})/(\d{1,2})\s*(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)",
    ):
        for yy, mm, dd, label in re.findall(pat, page_text):
            hd = f"{int(yy):04d}{int(mm):02d}{int(dd):02d}" if yy else resolve_date(int(mm), int(dd))
            add(hd, label)

    # 4) Meeting date-range fallback. BOAT RACE pages often expose a range even when
    # future day tabs are not links yet. Synthesize every day in the range.
    range_patterns = [
        r"(\d{1,2})月(\d{1,2})日\s*[～〜~\-－]\s*(\d{1,2})月(\d{1,2})日",
        r"(\d{1,2})/(\d{1,2})\s*[～〜~\-－]\s*(\d{1,2})/(\d{1,2})",
        r"(\d{1,2})月(\d{1,2})日\s*[～〜~\-－]\s*(\d{1,2})日",
        r"(\d{1,2})/(\d{1,2})\s*[～〜~\-－]\s*(\d{1,2})",
    ]

    range_start = range_end = None

    for idx, pat in enumerate(range_patterns):
        m = re.search(pat, page_text)
        if not m:
            continue

        if idx in (0, 1):
            sm, sd, em, ed = map(int, m.groups())
        else:
            sm, sd, ed = map(int, m.groups())
            em = sm

        sy = base_year
        ey = base_year
        if base_month == 12 and sm == 1:
            sy += 1
        if sm == 12 and em == 1:
            ey = sy + 1
        elif base_month == 1 and sm == 12:
            sy -= 1
            ey = sy if em == 12 else sy + 1

        try:
            range_start = datetime(sy, sm, sd).date()
            range_end = datetime(ey, em, ed).date()
        except ValueError:
            range_start = range_end = None
        if range_start and range_end and range_start <= range_end and (range_end-range_start).days <= 10:
            break

    # If a clear date range exists, use it to fill every day.
    if range_start and range_end:
        total = (range_end - range_start).days + 1
        for i in range(total):
            dt = range_start + timedelta(days=i)
            hd = dt.strftime("%Y%m%d")
            if i == 0:
                label = "初日"
            elif i == total - 1:
                label = "最終日"
            else:
                label = f"{i+1}日目"
            add(hd, label)

    result = sorted(out.values(), key=lambda x: x["date"])

    # Prefer a plausible continuous block containing base_date.
    if result:
        dates = [x["date"] for x in result]
        if base_date in dates:
            idx = dates.index(base_date)
            lo = hi = idx
            while lo > 0:
                a = datetime.strptime(dates[lo], "%Y%m%d").date()
                b = datetime.strptime(dates[lo-1], "%Y%m%d").date()
                if (a-b).days > 1:
                    break
                lo -= 1
            while hi < len(dates)-1:
                a = datetime.strptime(dates[hi+1], "%Y%m%d").date()
                b = datetime.strptime(dates[hi], "%Y%m%d").date()
                if (a-b).days > 1:
                    break
                hi += 1
            result = result[lo:hi+1]

    return result

def parse_racelist_meta(soup: BeautifulSoup) -> list[dict]:
    """Parse all six starters robustly, including lane 1 where status text can precede the name."""
    status_words = ("投票", "発売終了", "発売中", "投票受付中", "受付終了")
    found = []
    used = set()

    def clean_name(v: str) -> str:
        v = compact(v)
        for w in status_words:
            if v.startswith(w):
                v = compact(v[len(w):])
            if v.endswith(w):
                v = compact(v[:-len(w)])
        return v

    # Primary path: profile links carrying registration number.
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        mt = re.search(r"(?:[?&]|&amp;)toban=(\d{4})", href)
        if not mt:
            continue
        toban = mt.group(1)
        if toban in used:
            continue

        row = a.find_parent("tr") or a.find_parent("div") or a.parent
        text = compact((row or a).get_text(" ", strip=True))
        text = re.sub(r"^(?:投票|発売終了|発売中|投票受付中|受付終了)\s*", "", text)

        klass = ""
        mk = re.search(rf"{re.escape(toban)}\s*/?\s*(A1|A2|B1|B2)", text)
        if mk:
            klass = mk.group(1)

        name = clean_name(a.get_text(" ", strip=True))
        if not name or name == toban or re.fullmatch(r"A1|A2|B1|B2", name):
            # Find a Japanese name near the registration number.
            mn = re.search(
                rf"{re.escape(toban)}\s*/?\s*(?:A1|A2|B1|B2)\s+"
                r"([一-龥々ヶヵぁ-んァ-ヶー・　 ]{2,24}?)(?=\s+[一-龥ぁ-んァ-ヶー]+/)",
                text
            )
            if mn:
                name = clean_name(mn.group(1))

        branch, age = "", None
        mb = re.search(r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳", text)
        if mb:
            branch = mb.group(1)
            age = int(mb.group(3))

        found.append({
            "racerId": toban,
            "racerName": name,
            "class": klass,
            "branch": branch,
            "age": age,
        })
        used.add(toban)
        if len(found) == 6:
            break

    # Fallback: parse the page text as six racer records.
    if len(found) < 6:
        text = compact(soup.get_text(" ", strip=True))
        for w in status_words:
            text = text.replace(w, " ")

        pat = re.compile(
            r"(\d{4})\s*/?\s*(A1|A2|B1|B2)\s+"
            r"([一-龥々ヶヵぁ-んァ-ヶー・　 ]{2,24}?)\s+"
            r"([一-龥ぁ-んァ-ヶー]+)\/([一-龥ぁ-んァ-ヶー]+)\s+(\d{1,2})歳"
        )
        for toban, klass, name, branch, _origin, age in pat.findall(text):
            if toban in used:
                continue
            found.append({
                "racerId": toban,
                "racerName": clean_name(name),
                "class": klass,
                "branch": branch,
                "age": int(age),
            })
            used.add(toban)
            if len(found) == 6:
                break

    return found[:6]

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

def parse_course_trend(soup: BeautifulSoup) -> dict | None:
    """BOAT RACE公式 resultlist の最初の進入コース別結果表を抽出。"""
    rows = {}
    started = False
    for tr in soup.find_all("tr"):
        cells = [compact(x.get_text(" ", strip=True)) for x in tr.find_all(["th","td"])]
        if len(cells) < 7:
            continue
        label = cells[0]
        if label in ("1着","2着","3着"):
            vals = cells[1:7]
            if all(re.fullmatch(r"\d+(?:\.\d+)?%", v) for v in vals):
                if label not in rows:
                    rows[label] = vals
                    started = True
                if len(rows) == 3:
                    break
        elif started and rows:
            break

    if len(rows) != 3:
        return None

    text = compact(soup.get_text(" ", strip=True))
    # resultlistは終了済みレース分の集計。明示的なR数が取れなければ省略。
    completed = None
    race_nums = [int(x) for x in re.findall(r"(?:^|\s)(1[0-2]|[1-9])R(?:\s|$)", text)]
    if race_nums:
        completed = max(race_nums)

    return {
        "source":"BOAT RACE official resultlist",
        "rows":rows,
        "completedRaces":completed,
    }

def collect_venue_fast(code: str, date: str, old_meeting: dict | None, racer_cache: dict) -> dict | None:
    soup = get_soup(RACEINDEX_URL, {"hd":date,"jcd":code})
    races = parse_races(soup)
    if not races: return None

    title = extract_title(soup)
    text = compact(soup.get_text(" ", strip=True))
    day = day_label_from_text(text)
    meet_days = parse_meet_days(soup,date)

    old_meeting = old_meeting or {}
    course_trend = old_meeting.get("venueCourseTrend")
    try:
        result_soup = get_soup(RESULTLIST_URL, {"hd":date,"jcd":code}, timeout=14)
        parsed_trend = parse_course_trend(result_soup)
        if parsed_trend:
            course_trend = parsed_trend
    except Exception:
        pass

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
        "status":"open",
        "races":races,
        "meetDays":meet_days,
        "venueCourseTrend":course_trend,
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

def repair_missing_lane1(meetings: list[dict], racer_cache: dict, workers: int = 12):
    """
    Fast-mode repair:
    only fetch racelist for races whose lane-1 metadata is still missing.
    Once repaired, later fast runs inherit it from today.json, so this is normally a one-time cost.
    """
    tasks = []
    race_lookup = {}

    for m in meetings:
        for r in m.get("races", []):
            boats = r.get("boats", [])
            lane1 = next((b for b in boats if int(b.get("lane", 0)) == 1), None)
            needs = (
                lane1 is None
                or not lane1.get("racerId")
                or not lane1.get("branch")
                or lane1.get("age") in (None, "")
            )
            if needs:
                key = (m["venueCode"], int(r["raceNo"]))
                tasks.append((m["venueCode"], m["date"], int(r["raceNo"])))
                race_lookup[key] = r

    if not tasks:
        return

    print(f"[BOAT CHECK] lane1 repair tasks={len(tasks)}")

    with ThreadPoolExecutor(max_workers=min(max(workers, 1), 12)) as ex:
        futs = [ex.submit(fetch_racelist_task, *t) for t in tasks]
        for fut in as_completed(futs):
            code, rno, meta, err = fut.result()
            r = race_lookup.get((code, rno))
            if not r or len(meta) != 6:
                continue

            # Preserve lane ordering from official racelist.
            r["boats"] = [{"lane": i, **b} for i, b in enumerate(meta, 1)]

            # Re-attach cached period where available.
            for b in r["boats"]:
                rid = str(b.get("racerId", ""))
                period = racer_cache.get(rid, {}).get("period")
                if period:
                    b["period"] = period

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

    # Repair lane-1 metadata even in fast mode when it is missing.
    # Cached results are reused on subsequent runs.
    repair_missing_lane1(meetings, racer_cache, workers=workers)

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
