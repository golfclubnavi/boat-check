#!/usr/bin/env python3
"""
BOAT CHECK v50 collector — wider future odds coverage

LIVE（5分ごと）
- BOAT RACE公式の当日開催場 / 締切 / 中止情報を更新
- 取得済みの選手・モーター・ボート・直前・結果データを保持
- 締切35分前〜20分後のレースは直前情報を5分間隔で更新
- 締切後120分以内で未取得のレース結果・払戻を5分間隔で確認
- 公式で公開済みの先レースオッズも段階更新（近いRは5分、先Rは15〜30分）

ENRICH（1日1回 / 手動）
- 当日の全Rの出走表を取得
- F/L・平均ST・全国/当地勝率/2連率/3連率
- モーター番号/2連率/3連率、ボート番号/2連率/3連率
- 支部/出身/年齢/体重/登録番号、登録期キャッシュ
- 6艇内のモーター順位・ボート順位を2連率から算出
- 今節成績（レース番号/進入/ST/着順）
- 得点率/得点率順位/得点/減点/備考
- 今節平均ST/ST順位/1着率/2連率/3連率
- 前検タイム/前検順位

PHASE 1対象
- F/L、平均ST、全国/当地成績
- モーター/ボート基本値
- 展示タイム、チルト、体重、部品交換
- スタート展示ST（艇番が公式HTMLから判別できた場合のみ）
- 天候/風速/波高/気温/水温
- 着順、確定ST、決まり手、払戻

未取得値は作らず null / -- 相当で保持します。
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
BEFOREINFO_URL = BASE + "/owpc/pc/race/beforeinfo"
RACERESULT_URL = BASE + "/owpc/pc/race/raceresult"
POINT_RANK_URL = BASE + "/owpc/pc/race/pointrank"
RANKING_MOTOR_URL = BASE + "/owpc/pc/race/rankingmotor"
INFORMATION_URL = BASE + "/owpc/pc/race/information"
ODDS3T_URL = BASE + "/owpc/pc/race/odds3t"
ODDS3F_URL = BASE + "/owpc/pc/race/odds3f"
ODDS2TF_URL = BASE + "/owpc/pc/race/odds2tf"
ODDSK_URL = BASE + "/owpc/pc/race/oddsk"
ODDSTF_URL = BASE + "/owpc/pc/race/oddstf"
PROFILE_URL = BASE + "/owpc/pc/data/racersearch/profile"
BOATCAST_REPLAY_URL = "https://race.boatcast.jp/replay"

VENUES = {
    "01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
    "07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
    "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
    "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; BOAT-CHECK/0.50; +https://github.com/golfclubnavi/boat-check)",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.5",
}

def compact(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def boatcast_replay_url(code: str, date: str, race_no: int) -> str:
    # BOATCAST official per-race replay route.
    # Example format confirmed publicly: ?jo=4&ymd=YYYYMMDD&race=11
    return f"{BOATCAST_REPLAY_URL}?jo={int(code)}&ymd={date}&race={int(race_no)}"

def attach_replay_urls(code: str, date: str, races: list[dict]) -> None:
    for race in races:
        rno = int(race.get("raceNo") or 0)
        if not rno:
            continue
        page = boatcast_replay_url(code, date, rno)
        replay = race.setdefault("replay", {})
        replay.setdefault("officialPage", page)
        # The same official replay page provides both result replay and exhibition replay.
        # If a future collector finds separate media URLs, those keys can override this fallback.
        race.setdefault("officialReplayPage", page)

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
            name = re.sub(r"^(?:投票|発売終了|発売中|投票受付中|受付終了)\s*", "", name).strip()
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

def current_day_label_from_text(text: str, date: str) -> str:
    if not date or len(str(date)) != 8:
        return day_label_from_text(text)
    mm=int(str(date)[4:6]); dd=int(str(date)[6:8])
    pattern=rf"{mm}月{dd}日\s*(初日|[１２３４５６７８９一二三四五六七八九0-9]+日目|最終日)"
    m=re.search(pattern,text)
    return m.group(1) if m else day_label_from_text(text)

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
    # The currently selected official day is plain text rather than an <a>, so
    # always scan the page text too. This prevents the current date from
    # disappearing from the date tabs.
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

def _num(v, integer=False):
    if v is None:
        return None
    s = str(v).strip().replace(",", "").replace("%", "").replace("％", "")
    if not s or s in {"-", "--", "―", "－"}:
        return None
    try:
        n = float(s)
        return int(n) if integer else n
    except Exception:
        return None


def _dense_ranks(values, reverse=True):
    nums = [_num(v) for v in values]
    valid = sorted({x for x in nums if x is not None}, reverse=reverse)
    return [valid.index(x) + 1 if x is not None else None for x in nums]


def apply_equipment_ranks(boats: list[dict]) -> None:
    motor_rates = [
        (b.get("motor") or {}).get("twoRate", b.get("motorTwoRate")) for b in boats
    ]
    boat_rates = [
        (b.get("boat") or {}).get("twoRate", b.get("boatTwoRate")) for b in boats
    ]
    mr = _dense_ranks(motor_rates, reverse=True)
    br = _dense_ranks(boat_rates, reverse=True)
    for i, b in enumerate(boats):
        if mr[i] is not None:
            b.setdefault("motor", {})["rank"] = mr[i]
            b["motorRank"] = mr[i]
        if br[i] is not None:
            b.setdefault("boat", {})["rank"] = br[i]
            b["boatRank"] = br[i]



_ZEN_DIGITS = str.maketrans("１２３４５６７８９０", "1234567890")

def _day_no_from_label(label: str) -> int | None:
    s = str(label or "").translate(_ZEN_DIGITS)
    if "初日" in s: return 1
    m = re.search(r"(\d+)日目", s)
    if m: return int(m.group(1))
    return None

def _clean_series_cell(v: str) -> str:
    s = compact(str(v or "")).replace("\xa0", "").strip()
    return "" if s in {"", "-", "--", "―", "－"} else s

def _series_row_cells(tr) -> list[str]:
    if tr is None: return []
    cells=[_clean_series_cell(x.get_text(" ",strip=True)) for x in tr.find_all(["td","th"],recursive=False)]
    if len(cells)<12:
        cells=[_clean_series_cell(x.get_text(" ",strip=True)) for x in tr.find_all(["td","th"])]
    if len(cells)>=13 and (not cells[-1] or re.fullmatch(r"\d{1,2}R", cells[-1] or "")):
        cells=cells[:-1]
    return cells[-12:] if len(cells)>=12 else []

def _series_st_value(v: str):
    s=_clean_series_cell(v).translate(_ZEN_DIGITS).upper()
    if not s: return None
    if re.fullmatch(r"(?:F|L)?\.\d{2}",s): return s
    n=_num(s)
    return n if n is not None else s

def _series_finish_value(v: str):
    s=_clean_series_cell(v).translate(_ZEN_DIGITS).strip()
    if not s:
        return None
    if s in {"1","2","3","4","5","6"}:
        return int(s)

    u=s.upper().replace(" ","")
    if u in {"転","転覆"} or "転覆" in u:
        return "転"
    if u in {"落","落水"} or "落水" in u:
        return "落"
    if u=="F" or "フライング" in u:
        return "F"
    if u=="L" or "出遅" in u:
        return "L"
    return s

def parse_current_meet_results(racer_row) -> list[dict]:
    """Parse official 今節成績: race no / course / ST / finish, 12 slots."""
    if racer_row is None: return []
    rows=[racer_row]
    sib=racer_row
    for _ in range(3):
        sib=sib.find_next_sibling("tr") if sib else None
        if sib is None: break
        t=compact(sib.get_text(" ",strip=True))
        if re.search(r"\b\d{4}\s*/\s*(?:A1|A2|B1|B2)\b",t): break
        rows.append(sib)
    if len(rows)<4:
        nested=racer_row.find_all("tr")
        if len(nested)>=4: rows=nested[:4]
    if len(rows)<4: return []
    rc,cc,sc,fc=map(_series_row_cells,rows[:4])
    if not any((rc,cc,sc,fc)): return []
    out=[]
    for i in range(12):
        rv=(rc[i] if i<len(rc) else "").translate(_ZEN_DIGITS)
        cv=(cc[i] if i<len(cc) else "").translate(_ZEN_DIGITS)
        race_no=int(rv) if re.fullmatch(r"\d{1,2}",rv or "") else None
        mc=re.search(r"(?<!\d)([1-6])(?!\d)",cv or "")
        course=int(mc.group(1)) if mc else None
        st=_series_st_value(sc[i] if i<len(sc) else "")
        finish=_series_finish_value(fc[i] if i<len(fc) else "")
        if race_no is None and course is None and st is None and finish is None: continue
        out.append({"day":i//2+1,"slot":i%2+1,"raceNo":race_no,"course":course,"st":st,"finish":finish,"source":"official_racelist"})
    return out

def parse_point_rank(soup: BeautifulSoup) -> dict[str,dict]:
    """Official 得点率一覧 -> racerId keyed series summary."""
    out={}
    for tr in soup.find_all("tr"):
        raw_cells=[compact(x.get_text(" ",strip=True)) for x in tr.find_all(["td","th"],recursive=False)]
        cells=[x.translate(_ZEN_DIGITS) for x in raw_cells]
        rid_idx=next((i for i,x in enumerate(cells) if re.fullmatch(r"\d{4}",x)),None)
        class_idx=next((i for i,x in enumerate(cells) if i>(rid_idx if rid_idx is not None else -1) and x in {"A1","A2","B1","B2"}),None)

        if rid_idx is not None and class_idx is not None and class_idx+4 < len(cells):
            rid=cells[rid_idx]
            rank_raw=cells[0] if cells else ""
            rate=cells[class_idx+1]
            series=cells[class_idx+2]
            points=cells[class_idx+3]
            deduction=cells[class_idx+4]
            tail=" ".join(x for x in cells[class_idx+5:] if x)
            if not re.fullmatch(r"-?\d+(?:\.\d+)?|-",rate):
                continue
            if not re.fullmatch(r"\d+",points) or not re.fullmatch(r"\d+",deduction):
                continue
            remark=next((x for x in ("賞典除外","途中帰郷","帰郷","失格") if x in tail),None)
            out[rid]={
                "pointRank":int(rank_raw) if rank_raw.isdigit() else None,
                "pointRate":_num(rate),
                "points":_num(points,integer=True),
                "penalty":_num(deduction,integer=True),
                "seriesSummary":compact(series),
                "penaltyDetail":remark,
                "official":True,
            }
            continue

        # Fallback for compacted table markup.
        text=compact(tr.get_text(" ",strip=True)).translate(_ZEN_DIGITS)
        m=re.match(r"^(\d+|-)\s+(\d{4})\s+(.+?)\s+(A1|A2|B1|B2)\s+(-?\d+(?:\.\d+)?|-)\s+(.+?)\s+(\d+)\s+(\d+)(?:\s+(.*))?$",text)
        if not m: continue
        rank,rid,name,klass,rate,series,points,deduction,tail=m.groups()
        tail=compact(tail or "")
        remark=next((x for x in ("賞典除外","途中帰郷","帰郷","失格") if x in tail),None)
        out[rid]={"pointRank":int(rank) if rank.isdigit() else None,"pointRate":_num(rate),"points":_num(points,integer=True),"penalty":_num(deduction,integer=True),"seriesSummary":compact(series),"penaltyDetail":remark,"official":True}
    return out

def parse_ranking_motor(soup: BeautifulSoup) -> dict[str,dict]:
    out={}
    for tr in soup.find_all("tr"):
        text=compact(tr.get_text(" ",strip=True)).translate(_ZEN_DIGITS)
        m=re.match(r"^(\d+)\s+(\d{4})\s+(.+?)\s+(A1|A2|B1|B2)\s+(\d+)\s+(\d+(?:\.\d+)?)%?\s+(\d+)\s+(\d+(?:\.\d+)?)%?\s+(\d+(?:\.\d+)?)",text)
        if not m: continue
        rank,rid,name,klass,mno,m2,bno,b2,ptime=m.groups()
        out[rid]={"preInspectionRank":int(rank),"preInspectionTime":_num(ptime),"motorNo":int(mno),"motorTwoRate":_num(m2),"boatNo":int(bno),"boatTwoRate":_num(b2),"official":True}
    return out

def parse_meeting_information(soup: BeautifulSoup) -> dict[str,list[str]]:
    out={}
    for tr in soup.find_all("tr"):
        cells=[compact(x.get_text(" ",strip=True)) for x in tr.find_all(["td","th"],recursive=False)]
        if len(cells)<4 or not re.search(r"\d{1,2}/\d{1,2}"," ".join(cells)): continue
        action=" ".join(cells[3:])
        if not re.search(r"賞典除外|減点\d+点|処置なし|途中帰郷",action): continue
        key=re.sub(r"\s+","",cells[2])
        if key: out.setdefault(key,[]).append(action)
    return out

def _numeric_st(v):
    if v is None: return None
    s=str(v).strip().upper()
    if s.startswith(("F","L")): return None
    return _num(s)

def _merge_meet_result_lists(a,b):
    merged={}
    for item in (a or [])+(b or []):
        if not isinstance(item,dict): continue
        day=int(item.get("day") or item.get("meetDay") or 0)
        race_no=int(item.get("raceNo") or item.get("race") or 0)
        slot=int(item.get("slot") or 0)
        key=(day,race_no if race_no else 100+slot)
        x=dict(merged.get(key,{}))
        for k,v in item.items():
            if v not in (None,"",[],{}): x[k]=v
        merged[key]=x
    return sorted(merged.values(),key=lambda x:(int(x.get("day") or 99),int(x.get("raceNo") or 99),int(x.get("slot") or 9)))

def _current_day_result_entries(meeting:dict):
    day_no=_day_no_from_label(meeting.get("day"))
    if not day_no:
        dates=[d.get("date") for d in meeting.get("meetDays",[]) if d.get("date")]
        if meeting.get("date") in dates: day_no=dates.index(meeting["date"])+1
    day_no=day_no or 1
    out={}
    for race in meeting.get("races",[]):
        result=race.get("result") or {}
        if result.get("official") is not True: continue
        before_by_lane={int(x.get("lane") or 0):x for x in (race.get("beforeData") or [])}
        for f in result.get("finishers",[]):
            rid=str(f.get("racerId") or "")
            if not rid: continue
            lane=int(f.get("lane") or 0)
            before=before_by_lane.get(lane,{})
            out.setdefault(rid,[]).append({"day":day_no,"raceNo":int(race.get("raceNo") or 0),"course":f.get("course") or before.get("course"),"st":f.get("st"),"finish":f.get("rank"),"exhibitionTime":before.get("exhibitionTime"),"source":"official_result_live"})
    return out

def _meet_day_result_entries(meeting:dict):
    out={}
    days=meeting.get("meetDays",[]) or []
    date_to_day={str(d.get("date") or ""):i+1 for i,d in enumerate(days)}

    # include the current day even when meetDays was not enriched yet
    sources=[]
    for d in days:
        sources.append((date_to_day.get(str(d.get("date") or ""),1),d.get("races",[]) or []))
    current_date=str(meeting.get("date") or "")
    current_day=date_to_day.get(current_date) or _day_no_from_label(meeting.get("day")) or 1
    sources.append((current_day,meeting.get("races",[]) or []))

    seen=set()
    for day_no,races in sources:
        for race in races:
            rno=int(race.get("raceNo") or 0)
            result=race.get("result") or {}
            if result.get("official") is not True:
                continue
            for f in result.get("finishers",[]) or []:
                rid=str(f.get("racerId") or "")
                if not rid:
                    continue
                key=(rid,day_no,rno)
                if key in seen:
                    continue
                seen.add(key)
                out.setdefault(rid,[]).append({
                    "day":day_no,
                    "raceNo":rno,
                    "course":f.get("course"),
                    "st":f.get("st"),
                    "finish":f.get("rank"),
                    "source":"official_result",
                })
    return out

def apply_meeting_series_data(meeting:dict,point_map=None,pre_map=None,info_map=None):
    point_map=point_map or {}; pre_map=pre_map or {}; info_map=info_map or {}
    canonical={}
    for race in meeting.get("races",[]):
        for b in race.get("boats",[]):
            rid=str(b.get("racerId") or b.get("registrationNo") or "")
            if not rid: continue
            cur=canonical.setdefault(rid,{"meetResults":[]})
            cur["name"]=b.get("racerName") or cur.get("name")
            cur["meetResults"]=_merge_meet_result_lists(cur.get("meetResults",[]),b.get("meetResults",[]))
    for rid,items in _current_day_result_entries(meeting).items():
        cur=canonical.setdefault(rid,{"meetResults":[]})
        cur["meetResults"]=_merge_meet_result_lists(cur.get("meetResults",[]),items)
    for rid,items in _meet_day_result_entries(meeting).items():
        cur=canonical.setdefault(rid,{"meetResults":[]})
        cur["meetResults"]=_merge_meet_result_lists(cur.get("meetResults",[]),items)

    derived={}
    for rid,cur in canonical.items():
        hist=cur.get("meetResults",[])
        finish_nums=[int(x.get("finish")) for x in hist if isinstance(x.get("finish"),(int,float)) and 1<=int(x.get("finish"))<=6]
        sts=[_numeric_st(x.get("st")) for x in hist]; sts=[x for x in sts if x is not None]
        exs=[_num(x.get("exhibitionTime")) for x in hist]; exs=[x for x in exs if x is not None]
        courses=[_num(x.get("course")) for x in hist]; courses=[x for x in courses if x is not None]
        starts=len(finish_nums)
        derived[rid]={
            "avgST":round(sum(sts)/len(sts),3) if sts else None,
            "exhibitionTime":round(sum(exs)/len(exs),3) if exs else None,
            "avgCourse":round(sum(courses)/len(courses),2) if courses else None,
            "winRate":round(sum(1 for x in finish_nums if x==1)/starts*100,1) if starts else None,
            "twoRate":round(sum(1 for x in finish_nums if x<=2)/starts*100,1) if starts else None,
            "threeRate":round(sum(1 for x in finish_nums if x<=3)/starts*100,1) if starts else None,
            "starts":starts,
        }
    st_ids=sorted([rid for rid,v in derived.items() if v.get("avgST") is not None],key=lambda rid:derived[rid]["avgST"])
    ex_ids=sorted([rid for rid,v in derived.items() if v.get("exhibitionTime") is not None],key=lambda rid:derived[rid]["exhibitionTime"])
    st_rank={rid:i+1 for i,rid in enumerate(st_ids)}; ex_rank={rid:i+1 for i,rid in enumerate(ex_ids)}

    for race in meeting.get("races",[]):
        for b in race.get("boats",[]):
            rid=str(b.get("racerId") or b.get("registrationNo") or "")
            if not rid: continue
            can=canonical.get(rid,{})
            if can.get("meetResults"): b["meetResults"]=can["meetResults"]
            stats=dict(b.get("meetStats") or {})
            for k,v in derived.get(rid,{}).items():
                if v is not None: stats[k]=v
            if rid in st_rank: stats["stRank"]=st_rank[rid]
            if rid in ex_rank: stats["exhibitionRank"]=ex_rank[rid]
            for k in ("pointRank","pointRate","points","penalty","seriesSummary","penaltyDetail"):
                v=point_map.get(rid,{}).get(k)
                if v is not None: stats[k]=v
            pre=pre_map.get(rid,{})
            if pre.get("preInspectionTime") is not None: stats["preInspectionTime"]=pre["preInspectionTime"]
            if pre.get("preInspectionRank") is not None: stats["preInspectionRank"]=pre["preInspectionRank"]
            name_key=re.sub(r"\s+","",str(b.get("racerName") or ""))
            notes=info_map.get(name_key,[])
            if notes: stats["penaltyDetail"]=" / ".join(dict.fromkeys(notes))
            b["meetStats"]=stats
            if pre:
                if pre.get("motorNo") is not None:
                    b["motorNo"]=pre["motorNo"]; b.setdefault("motor",{})["motorNo"]=pre["motorNo"]
                if pre.get("motorTwoRate") is not None:
                    b["motorTwoRate"]=pre["motorTwoRate"]; b.setdefault("motor",{})["twoRate"]=pre["motorTwoRate"]
                if pre.get("boatNo") is not None:
                    b["boatNo"]=pre["boatNo"]; b.setdefault("boat",{})["boatNo"]=pre["boatNo"]
                if pre.get("boatTwoRate") is not None:
                    b["boatTwoRate"]=pre["boatTwoRate"]; b.setdefault("boat",{})["twoRate"]=pre["boatTwoRate"]

def _cell_texts(tr) -> list[str]:
    return [compact(x.get_text(" ", strip=True)).translate(_ZEN_DIGITS)
            for x in tr.find_all(["td","th"], recursive=False)]

def _numeric_tokens(text: str) -> list[str]:
    # Keep "-" placeholders while extracting the official three-line numeric blocks.
    return re.findall(r"(?<!\d)(?:--?|―|－|\d+(?:\.\d+)?)(?!\d)", str(text or ""))

def _triplet_from_cell(text: str):
    vals=_numeric_tokens(text)
    if len(vals) < 3:
        return None
    return vals[0], vals[1], vals[2]

def parse_racelist_meta(soup: BeautifulSoup) -> list[dict]:
    """
    Parse the BOAT RACE official racelist from table rows.

    Important:
    - Do NOT depend on racer-profile <a ...toban=...> links. The official markup
      can change while the visible table remains stable.
    - Locate the main row by "registrationNo / class".
    - Read F/L/ST, national/local, motor and boat data from the following cells.
    """
    found=[]
    used=set()

    for tr in soup.find_all("tr"):
        cells=_cell_texts(tr)
        if not cells:
            continue

        row_text=compact(" ".join(cells))
        mr=re.search(r"\b(\d{4})\s*/\s*(A1|A2|B1|B2)\b", row_text)
        if not mr:
            continue

        toban,klass=mr.groups()
        if toban in used:
            continue

        detail_idx=next(
            (i for i,c in enumerate(cells)
             if re.search(rf"\b{re.escape(toban)}\s*/\s*{klass}\b", c)),
            -1
        )
        if detail_idx < 0:
            continue

        # Lane is normally a cell before the racer-detail cell.
        lane_no=None
        for c in cells[:detail_idx+1]:
            mm=re.fullmatch(r"\s*([1-6])\s*", c)
            if mm:
                lane_no=int(mm.group(1))
                break

        detail=cells[detail_idx]
        md=re.search(
            rf"{re.escape(toban)}\s*/\s*{klass}\s+"
            rf"(.+?)\s+"
            rf"([一-龥々ヶヵぁ-んァ-ヶー]+)\s*/\s*([一-龥々ヶヵぁ-んァ-ヶー]+)\s+"
            rf"(\d{{1,2}})歳\s*/\s*(\d+(?:\.\d+)?)kg",
            detail
        )

        name=""
        branch=""
        origin=""
        age=None
        weight=None
        if md:
            name=compact(md.group(1))
            branch=md.group(2)
            origin=md.group(3)
            age=int(md.group(4))
            weight=_num(md.group(5))
        else:
            # Fallback if detail column spacing changes.
            tail=re.split(rf"{re.escape(toban)}\s*/\s*{klass}", detail, maxsplit=1)
            if len(tail)==2:
                name=compact(tail[1]).split(" ")[0]

        b={
            "racerId":toban,
            "registrationNo":toban,
            "racerName":name,
            "class":klass,
        }
        if lane_no is not None:
            b["lane"]=lane_no
        if branch:
            b["branch"]=branch
        if origin:
            b["origin"]=origin
        if age is not None:
            b["age"]=age
        if weight is not None:
            b["weight"]=weight

        # Find F/L/average-ST cell after the racer-detail cell.
        after=cells[detail_idx+1:]
        fl_idx=None
        for i,c in enumerate(after):
            fm=re.search(r"F\s*(\d+)\s+L\s*(\d+)\s+((?:--?|―|－|\d+(?:\.\d+)?))", c)
            if fm:
                fl_idx=i
                b["flyingCount"]=int(fm.group(1))
                b["lateCount"]=int(fm.group(2))
                b["avgST"]=_num(fm.group(3))
                break

        # The next four 3-value cells are 全国 / 当地 / モーター / ボート.
        groups=[]
        scan=after[(fl_idx+1 if fl_idx is not None else 0):]
        for c in scan:
            g=_triplet_from_cell(c)
            if g:
                groups.append(g)
                if len(groups)==4:
                    break

        if len(groups)>=1:
            nat_win,nat_two,nat_three=groups[0]
            b["nationalWinRate"]=_num(nat_win)
            b["national2Rate"]=_num(nat_two)
            b["national3Rate"]=_num(nat_three)
        if len(groups)>=2:
            loc_win,loc_two,loc_three=groups[1]
            b["localWinRate"]=_num(loc_win)
            b["local2Rate"]=_num(loc_two)
            b["local3Rate"]=_num(loc_three)
        if len(groups)>=3:
            motor_no,motor_two,motor_three=groups[2]
            b["motorNo"]=_num(motor_no,integer=True)
            b["motorTwoRate"]=_num(motor_two)
            b["motorThreeRate"]=_num(motor_three)
            b["motor"]={
                "motorNo":b["motorNo"],
                "twoRate":b["motorTwoRate"],
                "threeRate":b["motorThreeRate"],
            }
        if len(groups)>=4:
            boat_no,boat_two,boat_three=groups[3]
            b["boatNo"]=_num(boat_no,integer=True)
            b["boatTwoRate"]=_num(boat_two)
            b["boatThreeRate"]=_num(boat_three)
            b["boat"]={
                "boatNo":b["boatNo"],
                "twoRate":b["boatTwoRate"],
                "threeRate":b["boatThreeRate"],
            }

        if any(k in b for k in ("nationalWinRate","localWinRate","avgST")):
            b["stats"]={
                "winRate":{
                    "national":b.get("nationalWinRate"),
                    "local":b.get("localWinRate"),
                },
                "quinella":{
                    "national":b.get("national2Rate"),
                    "local":b.get("local2Rate"),
                },
                "trifecta":{
                    "national":b.get("national3Rate"),
                    "local":b.get("local3Rate"),
                },
                "st":{"overall":b.get("avgST")},
                "flyingCount":b.get("flyingCount"),
                "lateCount":b.get("lateCount"),
            }

        meet_results=parse_current_meet_results(tr)
        if meet_results:
            b["meetResults"]=meet_results

        found.append(b)
        used.add(toban)
        if len(found)==6:
            break

    apply_equipment_ranks(found)
    return found

def _merge_racer_name_key(v: str) -> str:
    s=compact(str(v or ""))
    s=re.sub(r"^(?:投票|発売終了|発売中|投票受付中|受付終了)\s*", "", s)
    return re.sub(r"[　\s]+", "", s)

def merge_racelist_meta_into_race(race: dict, meta: list[dict], racer_cache: dict) -> None:
    if not meta:
        return

    old_by_lane={
        int(b.get("lane",0)):dict(b)
        for b in race.get("boats",[])
        if int(b.get("lane",0)) in range(1,7)
    }
    merged={i:dict(old_by_lane.get(i,{"lane":i})) for i in range(1,7)}
    used_lanes=set()

    for pos,b in enumerate(meta,1):
        lane=int(b.get("lane") or 0)
        target_name=_merge_racer_name_key(b.get("racerName"))

        if lane not in range(1,7):
            lane=next((
                ln for ln,ob in merged.items()
                if ln not in used_lanes
                and target_name
                and _merge_racer_name_key(ob.get("racerName"))==target_name
            ),0)

        if lane not in range(1,7):
            lane=next((ln for ln in range(1,7) if ln not in used_lanes),0)

        if lane not in range(1,7):
            continue

        item=dict(merged.get(lane,{"lane":lane}))
        item.update({k:v for k,v in b.items() if v not in (None,"")})
        item["lane"]=lane

        rid=str(item.get("racerId") or "")
        period=racer_cache.get(rid,{}).get("period") if rid else None
        if period:
            item["period"]=period

        merged[lane]=item
        used_lanes.add(lane)

    race["boats"]=[merged[i] for i in range(1,7)]
    race["metaCount"]=len(meta)
    apply_equipment_ranks(race["boats"])

def merge_boat_details(new_races: list[dict], old_races: list[dict], racer_cache: dict):
    """Preserve enriched/live fields while refreshing raceindex timing/status."""
    old_by_race = {int(r.get("raceNo",0)): r for r in old_races or []}
    keep_race_keys = (
        "title", "beforeData", "before", "weather", "weatherData", "conditions",
        "result", "raceResult", "results", "payouts", "refunds", "odds", "oddsUpdatedAt", "oddsLastAttemptAt", "oddsSource",
        "replay", "officialReplayPage", "resultUpdatedAt", "beforeUpdatedAt",
    )

    for r in new_races:
        old = old_by_race.get(int(r.get("raceNo",0)), {})
        for key in keep_race_keys:
            if key not in r and old.get(key) not in (None, "", [], {}):
                r[key] = old[key]

        old_boats = {int(b.get("lane",0)): b for b in old.get("boats",[])}
        refreshed=[]
        for b in r.get("boats",[]):
            ob = old_boats.get(int(b.get("lane",0)), {})
            same = (
                not b.get("racerName") or not ob.get("racerName") or
                _merge_racer_name_key(b["racerName"]) == _merge_racer_name_key(ob["racerName"])
            )
            if same:
                merged = dict(ob)
                merged.update({k:v for k,v in b.items() if v not in (None, "")})
                b = merged
            rid = b.get("racerId")
            if rid and racer_cache.get(str(rid),{}).get("period"):
                b["period"] = racer_cache[str(rid)]["period"]
            refreshed.append(b)
        r["boats"] = refreshed
        apply_equipment_ranks(r.get("boats", []))

def old_meeting_map(old_payload: dict) -> dict:
    return {
        str(m.get("venueCode")): m
        for m in old_payload.get("meetings",[])
        if m.get("venueCode")
    }


def _racer_name_key(v) -> str:
    return _merge_racer_name_key(v)

def carry_ongoing_meeting_data(races: list[dict], old_meeting: dict, date: str, title: str, meet_days: list[dict]) -> None:
    """
    At JST midnight today.json switches to the new race date before the daily
    full enrichment may have completed.

    For a continuing meeting, entrants/equipment/series stats already known
    from yesterday are safely matched by racer name and carried forward.
    Race-specific fields such as lane/before/result are NOT copied.
    """
    if not old_meeting or not races:
        return

    old_dates = {
        str(d.get("date") or "")
        for d in old_meeting.get("meetDays", [])
        if d.get("date")
    }
    new_dates = {
        str(d.get("date") or "")
        for d in meet_days or []
        if d.get("date")
    }

    old_title = compact(str(old_meeting.get("title") or ""))
    new_title = compact(str(title or ""))

    # Continue only when the official schedule/title indicates the same meet.
    continuing = (
        date in old_dates
        or (
            old_title and new_title
            and old_title == new_title
            and bool(old_dates.intersection(new_dates))
        )
    )
    if not continuing:
        return

    source_by_name = {}
    source_races = list(old_meeting.get("races", []) or [])
    for day in old_meeting.get("meetDays", []) or []:
        source_races.extend(day.get("races", []) or [])

    # Prefer the richest record seen for each racer.
    for race in source_races:
        for boat in race.get("boats", []) or []:
            key = _racer_name_key(boat.get("racerName"))
            if not key:
                continue
            richness = sum(
                1 for k in (
                    "racerId","registrationNo","branch","origin","period","age",
                    "flyingCount","lateCount","avgST","meetResults","meetStats",
                    "motor","boat","motorNo","boatNo"
                )
                if boat.get(k) not in (None, "", [], {})
            )
            prev = source_by_name.get(key)
            if prev is None or richness > prev[0]:
                source_by_name[key] = (richness, boat)

    safe_keys = (
        "racerId","registrationNo","class","branch","origin","period","age","weight",
        "flyingCount","lateCount","avgST",
        "national","local","stats","racerStats","courseStats",
        "meetResults","meetStats",
        "motorNo","motorTwoRate","boatNo","boatTwoRate","motor","boat",
    )

    carried = 0
    for race in races:
        for boat in race.get("boats", []) or []:
            key = _racer_name_key(boat.get("racerName"))
            src_pair = source_by_name.get(key)
            if not src_pair:
                continue
            src = src_pair[1]
            for k in safe_keys:
                if boat.get(k) in (None, "", [], {}) and src.get(k) not in (None, "", [], {}):
                    # copy JSON-compatible nested values without sharing references
                    try:
                        boat[k] = json.loads(json.dumps(src[k], ensure_ascii=False))
                    except Exception:
                        boat[k] = src[k]
            carried += 1

    if carried:
        print(f"  CARRY {old_meeting.get('venueCode','--')} {old_meeting.get('venueName','')}: {carried} racer rows across midnight")

def collect_venue_fast(code: str, date: str, old_meeting: dict | None, racer_cache: dict) -> dict | None:
    soup = get_soup(RACEINDEX_URL, {"hd":date,"jcd":code})
    races = parse_races(soup)

    title = extract_title(soup)
    text = compact(soup.get_text(" ", strip=True))
    meeting_status, status_label = detect_meeting_status(text, races)

    if races:
        attach_replay_urls(code, date, races)

    if not races and meeting_status == "open":
        return None

    day = current_day_label_from_text(text,date)
    meet_days = parse_meet_days(soup,date)

    old_meeting = old_meeting or {}

    # If JST date has just rolled over during the same meeting, immediately
    # reuse yesterday's enriched racer/series data while today's full enrich runs.
    if old_meeting.get("date") and old_meeting.get("date") != date:
        carry_ongoing_meeting_data(races, old_meeting, date, title, meet_days)

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


def _infer_lane_from_start_row(tr, fallback_course: int | None = None) -> int | None:
    attrs=[]
    for tag in tr.find_all(True):
        for key,val in tag.attrs.items():
            if isinstance(val,(list,tuple)):
                val=" ".join(map(str,val))
            attrs.append(f"{key}={val}")
    blob=" ".join(attrs).lower()
    patterns=[
        r"(?:boat|teiban|lane|waku|frame)[_\-/]?(?:no)?[_\-]?([1-6])(?:\D|$)",
        r"(?:is-|color-|boatcolor)([1-6])(?:\D|$)",
    ]
    for pat in patterns:
        m=re.search(pat,blob)
        if m:
            return int(m.group(1))
    return None


def _weather_from_text(text: str) -> dict:
    out={}
    m=re.search(r"気温\s*(-?\d+(?:\.\d+)?)℃",text)
    if m: out["airTemperature"]=_num(m.group(1))
    m=re.search(r"水温\s*(-?\d+(?:\.\d+)?)℃",text)
    if m: out["waterTemperature"]=_num(m.group(1))
    m=re.search(r"風速\s*(\d+(?:\.\d+)?)m",text)
    if m: out["windSpeed"]=_num(m.group(1))
    m=re.search(r"波高\s*(\d+(?:\.\d+)?)cm",text)
    if m: out["waveHeight"]=_num(m.group(1))
    for w in ("晴", "曇り", "雨", "雪", "霧"):
        if w in text:
            out["weather"]=w
            break
    # Official page often renders wind direction as an image; only keep text when actually present.
    m=re.search(r"風向\s*(北東|南東|南西|北西|北|南|東|西)",text)
    if m: out["windDirection"]=m.group(1)
    return out


def parse_beforeinfo(soup: BeautifulSoup) -> dict:
    text=compact(soup.get_text(" ",strip=True))
    if "展示タイム" not in text and "展示 タイム" not in text and "スタート展示" not in text:
        return {}

    boats=[]
    seen=set()
    for tr in soup.find_all("tr"):
        row=compact(tr.get_text(" ",strip=True))
        # Main pre-race row: lane / racer / weight / exhibition / tilt ...
        m=re.match(
            r"^([1-6])\s+(.+?)\s+(\d+(?:\.\d+)?)kg\s+"
            r"(\d+(?:\.\d+)?|--?|-|―)\s+(-?\d+(?:\.\d+)?|--?|-|―)(?:\s+|$)",
            row,
        )
        if not m:
            continue
        lane=int(m.group(1))
        if lane in seen:
            continue
        name=compact(m.group(2))
        weight=_num(m.group(3))
        exhibition=_num(m.group(4))
        tilt=_num(m.group(5))
        item={"lane":lane,"racerName":name,"weight":weight,"exhibitionTime":exhibition,"tilt":tilt}

        parts=[]
        for p in ("ピストン", "リング", "電気", "キャブ", "シリンダ", "シャフト", "ギヤ", "キャリボ"):
            if p in row:
                parts.append(p)
        if "新" in row:
            parts.append("プロペラ新")
        if parts:
            item["partsExchange"]=" / ".join(dict.fromkeys(parts))
        boats.append(item)
        seen.add(lane)
        if len(boats)==6:
            break

    # Start exhibition. Map to lane only if the official HTML lets us infer the boat number.
    start_rows=[]
    start_area=False
    for tr in soup.find_all("tr"):
        row=compact(tr.get_text(" ",strip=True))
        if "コース" in row and "ST" in row:
            start_area=True
            continue
        if not start_area:
            continue
        if "水面気象情報" in row:
            break
        ms=re.match(r"^([1-6])\s+.*?((?:F|L)?\.\d{2})$",row)
        if not ms:
            continue
        course=int(ms.group(1))
        raw=ms.group(2)
        lane=_infer_lane_from_start_row(tr,course)
        st=_num(raw.lstrip("FL"))
        entry={"course":course,"lane":lane,"st":st,"rawST":raw}
        start_rows.append(entry)
        if lane:
            for b in boats:
                if b.get("lane")==lane:
                    b["course"]=course
                    b["st"]=raw if raw.startswith(("F","L")) else st
                    break

    return {
        "boats":boats,
        "startExhibition":start_rows,
        "weather":_weather_from_text(text),
    }


def _rank_zen(v: str) -> int | str | None:
    table=str.maketrans("１２３４５６","123456")
    s=str(v or "").translate(table).strip()
    if s in {"1","2","3","4","5","6"}: return int(s)
    if s: return s
    return None


def _payout_pairs(segment: str, combo_len: int) -> list[dict]:
    if combo_len==3:
        pat=r"([1-6]\s*[-=＝]\s*[1-6]\s*[-=＝]\s*[1-6])\s*[¥￥]?\s*([\d,]+)"
    elif combo_len==2:
        pat=r"([1-6]\s*[-=＝]\s*[1-6])\s*[¥￥]?\s*([\d,]+)"
    else:
        pat=r"(?:^|\s)([1-6])\s*[¥￥]?\s*([\d,]+)"
    out=[]
    for combo,amount in re.findall(pat,segment):
        combo=re.sub(r"\s+","",combo).replace("＝","=")
        out.append({"combination":combo,"payout":_num(amount,integer=True)})
    return out


def parse_raceresult(soup: BeautifulSoup) -> dict:
    text=compact(soup.get_text(" ",strip=True))
    if "着 枠 ボートレーサー" not in text and "払戻金" not in text:
        return {}

    finishers=[]
    seen_lanes=set()

    def _official_finish_rank(v):
        s=compact(str(v or "")).translate(_ZEN_DIGITS).strip()
        if s in {"1","2","3","4","5","6"}:
            return int(s)
        u=s.upper().replace(" ","")
        if u in {"転","転覆"} or "転覆" in u:
            return "転"
        if u in {"落","落水"} or "落水" in u:
            return "落"
        if u=="F" or "フライング" in u:
            return "F"
        if u=="L" or "出遅" in u:
            return "L"
        return s or None

    for tr in soup.find_all("tr"):
        cells=[compact(x.get_text(" ",strip=True)) for x in tr.find_all(["td","th"],recursive=False)]
        if len(cells)<3:
            continue

        rank=_official_finish_rank(cells[0])
        lane_raw=cells[1].translate(_ZEN_DIGITS).strip()
        if rank is None or not re.fullmatch(r"[1-6]",lane_raw):
            continue

        lane=int(lane_raw)
        if lane in seen_lanes:
            continue

        racer_text=cells[2]
        mr=re.search(r"(\d{4})\s+(.+)",racer_text)
        if not mr:
            continue

        time_val=cells[3] if len(cells)>=4 and re.fullmatch(r"1'\d{2}\"\d",cells[3] or "") else None

        finishers.append({
            "rank":rank,
            "lane":lane,
            "racerId":mr.group(1),
            "racerName":compact(mr.group(2)),
            "time":time_val,
        })
        seen_lanes.add(lane)
        if len(finishers)==6:
            break

    # Final ST / winning move from the start information block.
    start_block=text
    if "スタート情報" in text:
        start_block=text.split("スタート情報",1)[1]
    if "勝式" in start_block:
        start_block=start_block.split("勝式",1)[0]
    st_map={}
    start_entries=[]
    for idx,(lane,raw,move) in enumerate(re.findall(
        r"(?:^|\s)([1-6])\s+((?:F|L)?\.\d{2})(?:\s+(逃げ|差し|まくり差し|まくり|抜き|恵まれ))?",
        start_block,
    ),1):
        entry={"st":raw,"move":move or "","course":idx}
        st_map[int(lane)]=entry
        start_entries.append({"lane":int(lane),"course":idx,"st":raw,"move":move or ""})
    for f in finishers:
        st=st_map.get(int(f.get("lane") or 0))
        if st:
            f["st"]=st["st"]
            f["course"]=st["course"]
            if st["move"]:
                f["kimarite"]=st["move"]

    kimarite=""
    mk=re.search(r"決まり手\s*(逃げ|差し|まくり差し|まくり|抜き|恵まれ)",text)
    if mk:
        kimarite=mk.group(1)
    elif st_map:
        kimarite=next((x["move"] for x in st_map.values() if x.get("move")),"")
    if kimarite:
        for f in finishers:
            if f.get("rank")==1:
                f["kimarite"]=kimarite
                break

    payouts={}
    if "勝式" in text:
        ptext=text.split("勝式",1)[1]
        if "水面気象情報" in ptext:
            ptext=ptext.split("水面気象情報",1)[0]
        labels=[
            ("3連単","trifecta",3),("3連複","trio",3),
            ("2連単","exacta",2),("2連複","quinella",2),
            ("拡連複","wide",2),("単勝","win",1),("複勝","place",1),
        ]
        positions=[]
        for label,key,n in labels:
            idx=ptext.find(label)
            if idx>=0: positions.append((idx,label,key,n))
        positions.sort()
        for i,(idx,label,key,n) in enumerate(positions):
            end=positions[i+1][0] if i+1<len(positions) else len(ptext)
            seg=ptext[idx+len(label):end]
            vals=_payout_pairs(seg,n)
            if vals:
                payouts[key]=vals

    refund=None
    mr=re.search(r"返還\s*([1-6](?:\s*[・,]\s*[1-6])*)",text)
    if mr:
        refund=[int(x) for x in re.findall(r"[1-6]",mr.group(1))]

    note=""
    mn=re.search(r"備考\s*(.+?)(?:ボートレースガイド|レース結果一覧|$)",text)
    if mn:
        candidate=compact(mn.group(1))
        if candidate and candidate not in {"---","-"}:
            note=candidate[:200]

    if not finishers and not payouts and not kimarite:
        return {}

    result={
        "finishers":finishers,
        "payouts":payouts,
        "weather":_weather_from_text(text),
        "kimarite":kimarite or None,
        "startEntries":start_entries,
        "official":True,
    }
    if refund: result["refund"]=refund
    if note: result["note"]=note
    return result




def fetch_profile_period(toban: str):
    """
    BOAT RACE公式レーサープロフィールから登録期を取得。
    ネットワークエラーやHTML変更があってもEnrich全体を落とさない。
    """
    rid=str(toban or "").strip()
    info={"period":None}
    if not re.fullmatch(r"\d{4}", rid):
        return rid, info

    try:
        soup=get_soup(PROFILE_URL, {"toban":rid}, timeout=18)
        text=compact(soup.get_text(" ", strip=True)).translate(_ZEN_DIGITS)

        m=re.search(r"登録期\s*(\d{1,3})期", text)
        if m:
            info["period"]=int(m.group(1))

        # 取得できる範囲でキャッシュしておく。
        m=re.search(r"支部\s*([一-龥々ヶヵぁ-んァ-ヶー]+)", text)
        if m:
            info["branch"]=m.group(1)

        m=re.search(r"出身地\s*([一-龥々ヶヵぁ-んァ-ヶー]+)", text)
        if m:
            info["origin"]=m.group(1)

        m=re.search(r"体重\s*(\d+(?:\.\d+)?)kg", text)
        if m:
            info["weight"]=_num(m.group(1))

        m=re.search(r"級別\s*(A1|A2|B1|B2)級?", text)
        if m:
            info["class"]=m.group(1)

        info["profileCheckedAt"]=datetime.now(JST).isoformat(timespec="seconds")
        return rid, info

    except Exception as e:
        # 個別選手のプロフィール取得失敗で全体をFailureにしない。
        info["profileError"]=f"{type(e).__name__}: {e}"
        info["profileCheckedAt"]=datetime.now(JST).isoformat(timespec="seconds")
        return rid, info



def _odds_table_after_label(soup: BeautifulSoup, label: str):
    node=soup.find(string=lambda s: isinstance(s,str) and label in compact(s))
    if node:
        parent=node.parent
        table=parent.find_next("table") if parent else None
        if table:
            return table

    # Fallback: choose a table whose nearby text contains the label.
    for table in soup.find_all("table"):
        prev=table.find_previous(["h2","h3","h4","div","p"])
        if prev and label in compact(prev.get_text(" ",strip=True)):
            return table
    return None

def _expand_html_table(table) -> list[list[str]]:
    """
    Expand rowspan/colspan into a rectangular text grid.
    This makes BOAT RACE's odds matrices easy to parse without relying on CSS classes.
    """
    if table is None:
        return []

    grid=[]
    spans={}  # col -> (remaining_rows, value)

    for tr in table.find_all("tr"):
        row=[]
        col=0

        def fill_spans_until_open():
            nonlocal col
            while col in spans:
                remaining,value=spans[col]
                row.append(value)
                if remaining<=1:
                    spans.pop(col,None)
                else:
                    spans[col]=(remaining-1,value)
                col+=1

        fill_spans_until_open()

        cells=tr.find_all(["th","td"],recursive=False)
        for cell in cells:
            fill_spans_until_open()

            value=compact(cell.get_text(" ",strip=True)).translate(_ZEN_DIGITS)
            try:
                rowspan=max(1,int(cell.get("rowspan",1)))
            except Exception:
                rowspan=1
            try:
                colspan=max(1,int(cell.get("colspan",1)))
            except Exception:
                colspan=1

            for _ in range(colspan):
                row.append(value)
                if rowspan>1:
                    spans[col]=(rowspan-1,value)
                col+=1

        fill_spans_until_open()
        grid.append(row)

    width=max((len(r) for r in grid),default=0)
    return [r+[""]*(width-len(r)) for r in grid]

def _lane_token(v):
    s=compact(str(v or "")).translate(_ZEN_DIGITS)
    if re.fullmatch(r"[1-6]",s):
        return int(s)
    return None

def _odds_token(v):
    s=compact(str(v or "")).translate(_ZEN_DIGITS).replace(",","")
    if re.fullmatch(r"\d+(?:\.\d+)?",s):
        try:
            return float(s)
        except Exception:
            return None
    return None

def _range_odds_token(v):
    s=compact(str(v or "")).translate(_ZEN_DIGITS).replace("〜","-").replace("～","-")
    m=re.fullmatch(r"(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)",s)
    if not m:
        return None
    return [float(m.group(1)),float(m.group(2))]

def _dedupe_odds(entries: list[dict]) -> list[dict]:
    out=[]
    seen=set()
    for x in entries:
        combo=str(x.get("combination") or "")
        if not combo or combo in seen:
            continue
        seen.add(combo)
        out.append(x)
    return out

def _parse_matrix_three(table, unordered=False) -> list[dict]:
    """
    3連単 / 3連複.
    Official matrix uses 3-column groups: 2nd(or next) / 3rd / odds,
    with the first boat implied by the column group.
    """
    grid=_expand_html_table(table)
    if not grid:
        return []

    best=[]
    width=max(len(r) for r in grid)
    for offset in range(3):
        entries=[]
        groups=(width-offset)//3
        for row in grid:
            for g in range(groups):
                c=offset+g*3
                if c+2>=len(row):
                    continue
                a=_lane_token(row[c])
                b=_lane_token(row[c+1])
                odd=_odds_token(row[c+2])
                first=g+1
                if first not in range(1,7) or a is None or b is None or odd is None:
                    continue
                if len({first,a,b})<3:
                    continue
                combo=[first,a,b]
                if unordered:
                    combo=sorted(combo)
                entries.append({
                    "combination":"-".join(map(str,combo)),
                    "odds":odd,
                })
        entries=_dedupe_odds(entries)
        if len(entries)>len(best):
            best=entries
    return best

def _parse_matrix_two(table, unordered=False, range_value=False) -> list[dict]:
    """
    2連単 / 2連複 / 拡連複.
    Official matrix uses 2-column groups: other boat / odds,
    with the first boat implied by the column group.
    """
    grid=_expand_html_table(table)
    if not grid:
        return []

    best=[]
    width=max(len(r) for r in grid)
    for offset in range(2):
        entries=[]
        groups=(width-offset)//2
        for row in grid:
            for g in range(groups):
                c=offset+g*2
                if c+1>=len(row):
                    continue
                other=_lane_token(row[c])
                value=_range_odds_token(row[c+1]) if range_value else _odds_token(row[c+1])
                first=g+1
                if first not in range(1,7) or other is None or value is None or first==other:
                    continue
                combo=[first,other]
                if unordered:
                    combo=sorted(combo)
                item={"combination":"-".join(map(str,combo))}
                if range_value:
                    item["odds"]=value
                    item["min"]=value[0]
                    item["max"]=value[1]
                else:
                    item["odds"]=value
                entries.append(item)
        entries=_dedupe_odds(entries)
        if len(entries)>len(best):
            best=entries
    return best

def _parse_win_place_table(table, is_place=False) -> list[dict]:
    if table is None:
        return []
    out=[]
    for tr in table.find_all("tr"):
        cells=[compact(x.get_text(" ",strip=True)).translate(_ZEN_DIGITS)
               for x in tr.find_all(["th","td"],recursive=False)]
        if len(cells)<2:
            continue

        lane=None
        for c in cells[:2]:
            lane=_lane_token(c)
            if lane is not None:
                break
        if lane is None:
            continue

        if is_place:
            val=next((_range_odds_token(c) for c in reversed(cells) if _range_odds_token(c) is not None),None)
            if val is None:
                continue
            out.append({"combination":str(lane),"odds":val,"min":val[0],"max":val[1]})
        else:
            val=next((_odds_token(c) for c in reversed(cells) if _odds_token(c) is not None),None)
            if val is None:
                continue
            out.append({"combination":str(lane),"odds":val})
    return _dedupe_odds(out)

def parse_official_odds(
    soup3t: BeautifulSoup,
    soup3f: BeautifulSoup,
    soup2tf: BeautifulSoup,
    soupk: BeautifulSoup,
    souptf: BeautifulSoup,
) -> dict:
    trifecta=_parse_matrix_three(_odds_table_after_label(soup3t,"3連単オッズ"),unordered=False)
    trio=_parse_matrix_three(_odds_table_after_label(soup3f,"3連複オッズ"),unordered=True)

    exacta=_parse_matrix_two(_odds_table_after_label(soup2tf,"2連単オッズ"),unordered=False)
    quinella=_parse_matrix_two(_odds_table_after_label(soup2tf,"2連複オッズ"),unordered=True)

    wide=_parse_matrix_two(_odds_table_after_label(soupk,"拡連複オッズ"),unordered=True,range_value=True)

    win=_parse_win_place_table(_odds_table_after_label(souptf,"単勝オッズ"),is_place=False)
    place=_parse_win_place_table(_odds_table_after_label(souptf,"複勝オッズ"),is_place=True)

    return {
        "trifecta":trifecta,
        "trio":trio,
        "exacta":exacta,
        "quinella":quinella,
        "wide":wide,
        "win":win,
        "place":place,
        "official":bool(trifecta or trio or exacta or quinella or wide or win or place),
        "counts":{
            "trifecta":len(trifecta),
            "trio":len(trio),
            "exacta":len(exacta),
            "quinella":len(quinella),
            "wide":len(wide),
            "win":len(win),
            "place":len(place),
        },
    }

def fetch_odds_task(code: str, date: str, race_no: int):
    params={"rno":race_no,"jcd":code,"hd":date}
    try:
        # Five official pages cover all seven wager types.
        with ThreadPoolExecutor(max_workers=5) as ex:
            futs={
                "3t":ex.submit(get_soup,ODDS3T_URL,params,16),
                "3f":ex.submit(get_soup,ODDS3F_URL,params,16),
                "2tf":ex.submit(get_soup,ODDS2TF_URL,params,16),
                "k":ex.submit(get_soup,ODDSK_URL,params,16),
                "tf":ex.submit(get_soup,ODDSTF_URL,params,16),
            }
            soups={k:f.result() for k,f in futs.items()}

        data=parse_official_odds(
            soups["3t"],soups["3f"],soups["2tf"],soups["k"],soups["tf"]
        )
        return code,race_no,data,None
    except Exception as e:
        return code,race_no,{},f"{type(e).__name__}: {e}"


def fetch_point_rank_task(code: str, date: str):
    try:
        soup=get_soup(POINT_RANK_URL,{"jcd":code,"hd":date},timeout=18)
        return code,parse_point_rank(soup),None
    except Exception as e:
        return code,{},f"{type(e).__name__}: {e}"

def fetch_ranking_motor_task(code: str, date: str):
    try:
        soup=get_soup(RANKING_MOTOR_URL,{"jcd":code,"hd":date},timeout=18)
        return code,parse_ranking_motor(soup),None
    except Exception as e:
        return code,{},f"{type(e).__name__}: {e}"

def fetch_information_task(code: str, date: str):
    try:
        soup=get_soup(INFORMATION_URL,{"jcd":code,"hd":date},timeout=18)
        return code,parse_meeting_information(soup),None
    except Exception as e:
        return code,{},f"{type(e).__name__}: {e}"

def fetch_beforeinfo_task(code: str, date: str, race_no: int):
    try:
        soup=get_soup(BEFOREINFO_URL,{"rno":race_no,"jcd":code,"hd":date},timeout=16)
        return code,race_no,parse_beforeinfo(soup),None
    except Exception as e:
        return code,race_no,{},f"{type(e).__name__}: {e}"


def fetch_result_task(code: str, date: str, race_no: int):
    try:
        soup=get_soup(RACERESULT_URL,{"rno":race_no,"jcd":code,"hd":date},timeout=16)
        return code,race_no,parse_raceresult(soup),None
    except Exception as e:
        return code,race_no,{},f"{type(e).__name__}: {e}"


def _minutes_from_now(deadline: str) -> int | None:
    if not deadline or not re.fullmatch(r"\d{1,2}:\d{2}",str(deadline)):
        return None
    now=datetime.now(JST)
    h,m=map(int,str(deadline).split(":"))
    target=now.replace(hour=h,minute=m,second=0,microsecond=0)
    return int((target-now).total_seconds()//60)


def enrich_realtime(payload: dict, workers: int=8, live: bool=False) -> None:
    """
    Dynamic official data refresh.

    LIVE mode (5-minute workflow):
      - beforeinfo: 35 minutes before cutoff through 20 minutes after
      - result/refund: closed races up to 120 minutes after cutoff, until official result exists

    FAST/ENRICH mode:
      - wider recovery window for beforeinfo
      - any closed race without an official result is retried
    """
    before_tasks=[]
    result_tasks=[]
    odds_tasks=[]

    for meeting in payload.get("meetings",[]):
        code=meeting.get("venueCode")
        date=meeting.get("date")
        for race in meeting.get("races",[]):
            rno=int(race.get("raceNo") or 0)
            mins=_minutes_from_now(race.get("deadline",""))
            if not rno or mins is None:
                continue

            if live:
                # Exhibition/start-exhibition can change close to cutoff.
                if -20 <= mins <= 35:
                    before_tasks.append((code,date,rno))

                # Results are normally available soon after the race.
                result=race.get("result") or {}
                if -120 <= mins < 0 and not result.get("official"):
                    result_tasks.append((code,date,rno))
            else:
                # Wider recovery window for manual / enrichment runs.
                if -180 <= mins <= 120:
                    before_tasks.append((code,date,rno))

                result=race.get("result") or {}
                if mins < 0 and not result.get("official"):
                    result_tasks.append((code,date,rno))

    # Odds:
    # 公式で公開されている範囲は、先のレースもできるだけ取得する。
    # ただし全12Rを5分ごとに再取得すると負荷が大きいため、
    # 締切までの残り時間で更新間隔を段階化する。
    #
    #   ～120分 : 5分ごと
    #   ～240分 : 15分ごと
    #   240分超 : 30分ごと
    #
    # 未取得レースは時間帯に関係なく一度取得を試す。
    def _odds_refresh_due(race, mins):
        updated=race.get("oddsUpdatedAt")
        attempted=race.get("oddsLastAttemptAt")
        has_odds=bool((race.get("odds") or {}).get("official"))

        # 未公開レースも5分ごとに全件叩かない。
        # 一度も試していない場合だけ即時、以降は30分ごとに再試行。
        if not has_odds:
            if not attempted:
                return True
            try:
                last=datetime.fromisoformat(str(attempted))
                if last.tzinfo is None:
                    last=last.replace(tzinfo=JST)
                age=(datetime.now(JST)-last.astimezone(JST)).total_seconds()/60
                return age >= 30
            except Exception:
                return True

        if not updated:
            return True

        if mins <= 120:
            interval=5
        elif mins <= 240:
            interval=15
        else:
            interval=30

        try:
            last=datetime.fromisoformat(str(updated))
            if last.tzinfo is None:
                last=last.replace(tzinfo=JST)
            age=(datetime.now(JST)-last.astimezone(JST)).total_seconds()/60
            return age >= interval
        except Exception:
            return True

    for meeting in payload.get("meetings",[]):
        candidates=[]
        for race in meeting.get("races",[]):
            rno=int(race.get("raceNo") or 0)
            mins=_minutes_from_now(race.get("deadline",""))
            if not rno or mins is None:
                continue

            # 締切済み直後は最終オッズ確認、未来レースは全て候補。
            if mins >= -10 and _odds_refresh_due(race,mins):
                candidates.append((mins,rno))

        # 近いRから処理。1回のLive更新で各場最大6Rまでに制限し、
        # 次の5分更新で残りRも順次埋める。
        candidates.sort(key=lambda x:x[0])
        for _,rno in candidates[:6]:
            odds_tasks.append((meeting.get("venueCode"),meeting.get("date"),rno))

    if odds_tasks:
        # Deduplicate in case the same race is encountered twice.
        odds_tasks=list(dict.fromkeys(odds_tasks))
        print(f"[BOAT CHECK] LIVE odds tasks={len(odds_tasks)}")
        odds_results={}
        with ThreadPoolExecutor(max_workers=min(max(workers,8),12)) as ex:
            futs=[ex.submit(fetch_odds_task,*x) for x in odds_tasks]
            for fut in as_completed(futs):
                code,rno,data,err=fut.result()
                odds_results[(code,rno)]=(data,err)

        for meeting in payload.get("meetings",[]):
            for race in meeting.get("races",[]):
                key=(meeting.get("venueCode"),int(race.get("raceNo") or 0))
                data,err=odds_results.get(key,({},None))
                if data and data.get("official"):
                    race["odds"]=data
                    race["oddsUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")
                    race["oddsLastAttemptAt"]=race["oddsUpdatedAt"]
                    race["oddsSource"]="BOAT RACE official"
                else:
                    # 先のレースはまだ公式オッズ未公開の場合がある。
                    # エラー扱いで表示を壊さず、試行時刻だけ記録して次回再取得する。
                    race["oddsLastAttemptAt"]=datetime.now(JST).isoformat(timespec="seconds")
                    if err:
                        race.setdefault("liveErrors",{})["odds"]=err

    if before_tasks:
        print(f"[BOAT CHECK] LIVE beforeinfo tasks={len(before_tasks)}")
        results={}
        with ThreadPoolExecutor(max_workers=min(workers,8)) as ex:
            futs=[ex.submit(fetch_beforeinfo_task,*x) for x in before_tasks]
            for fut in as_completed(futs):
                code,rno,data,err=fut.result()
                results[(code,rno)]=(data,err)
        for meeting in payload.get("meetings",[]):
            for race in meeting.get("races",[]):
                key=(meeting.get("venueCode"),int(race.get("raceNo") or 0))
                data,err=results.get(key,({},None))
                if data:
                    race["beforeData"]=data.get("boats",[])
                    race["startExhibition"]=data.get("startExhibition",[])
                    if data.get("weather"):
                        race["weather"]=data["weather"]
                    race["beforeUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")
                    by_lane={int(x.get("lane") or 0):x for x in data.get("boats",[])}
                    for b in race.get("boats",[]):
                        d=by_lane.get(int(b.get("lane") or 0))
                        if d:
                            b["before"]=d
                            if d.get("weight") is not None:
                                b["weight"]=d["weight"]
                elif err:
                    race.setdefault("liveErrors",{})["beforeinfo"]=err

    if result_tasks:
        print(f"[BOAT CHECK] LIVE result tasks={len(result_tasks)}")
        results={}
        with ThreadPoolExecutor(max_workers=min(workers,8)) as ex:
            futs=[ex.submit(fetch_result_task,*x) for x in result_tasks]
            for fut in as_completed(futs):
                code,rno,data,err=fut.result()
                results[(code,rno)]=(data,err)
        for meeting in payload.get("meetings",[]):
            for race in meeting.get("races",[]):
                key=(meeting.get("venueCode"),int(race.get("raceNo") or 0))
                data,err=results.get(key,({},None))
                if data:
                    race["result"]=data
                    if data.get("weather"):
                        race["resultWeather"]=data["weather"]
                    race["resultUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")
                elif err:
                    race.setdefault("liveErrors",{})["result"]=err


    # 得点率一覧は1場1ページなので5分更新でも軽量。結果反映と同時に節間成績へ同期する。
    point_maps={}
    with ThreadPoolExecutor(max_workers=min(workers,8)) as ex:
        futs={ex.submit(fetch_point_rank_task,m.get("venueCode"),m.get("date")):m.get("venueCode") for m in payload.get("meetings",[])}
        for fut in as_completed(futs):
            code=futs[fut]
            try: _,data,err=fut.result()
            except Exception as e: data,err={},f"{type(e).__name__}: {e}"
            point_maps[code]=data
            if err:
                for mm in payload.get("meetings",[]):
                    if mm.get("venueCode")==code: mm.setdefault("liveErrors",{})["pointrank"]=err; break
    for meeting in payload.get("meetings",[]):
        apply_meeting_series_data(meeting,point_map=point_maps.get(meeting.get("venueCode"),{}))
        meeting["meetDataLiveUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")

def fetch_past_day_task(code: str, hd: str):
    try:
        soup=get_soup(RACEINDEX_URL,{"hd":hd,"jcd":code})
        return code,hd,parse_races(soup),None
    except Exception as e:
        return code,hd,[],f"{type(e).__name__}: {e}"

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

            if meta:
                merge_racelist_meta_into_race(r,meta,racer_cache)

            if err:
                r["metaError"] = err

    ref_results={}
    print(f"[BOAT CHECK] ENRICH meet-reference tasks={len(meetings)*3}")
    with ThreadPoolExecutor(max_workers=min(workers,10)) as ex:
        futs={}
        for m in meetings:
            code,hd=m["venueCode"],m["date"]
            futs[ex.submit(fetch_point_rank_task,code,hd)]=(code,"point")
            futs[ex.submit(fetch_ranking_motor_task,code,hd)]=(code,"pre")
            futs[ex.submit(fetch_information_task,code,hd)]=(code,"info")
        for fut in as_completed(futs):
            code,kind=futs[fut]
            try: _,data,err=fut.result()
            except Exception as e: data,err={},f"{type(e).__name__}: {e}"
            ref_results.setdefault(code,{})[kind]=data
            if err: ref_results.setdefault(code,{}).setdefault("errors",{})[kind]=err
    for m in meetings:
        ref=ref_results.get(m["venueCode"],{})
        apply_meeting_series_data(m,ref.get("point",{}),ref.get("pre",{}),ref.get("info",{}))
        m["meetDataUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")
        if ref.get("errors"): m["meetDataErrors"]=ref["errors"]

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
                    existing=d.get("races",[]) or []
                    merge_boat_details(races,existing,racer_cache)
                    d["races"] = races

    # 過去日の出走表が以前の更新で「名前/級だけ」に戻ってしまった場合だけ、
    # 公式 racelist から詳細データを再取得して復旧する。
    # 一度復旧したレースは次回以降スキップするので、通常運用では軽い。
    past_meta_tasks=[]
    for m in meetings:
        for d in m.get("meetDays",[]):
            if not d.get("date") or d["date"] >= m.get("date",""):
                continue
            for r in d.get("races",[]):
                boats=r.get("boats",[]) or []
                rich=sum(1 for b in boats if b.get("racerId") and (b.get("branch") or b.get("period") or b.get("avgST") is not None))
                if len(boats) and rich < min(6,len(boats)):
                    past_meta_tasks.append((m["venueCode"],d["date"],int(r.get("raceNo") or 0)))

    past_meta_tasks=[x for x in past_meta_tasks if x[2]]
    if past_meta_tasks:
        print(f"[BOAT CHECK] ENRICH historical racelist recovery tasks={len(past_meta_tasks)}")
        past_meta_results={}
        with ThreadPoolExecutor(max_workers=min(max(workers,12),16)) as ex:
            futs={ex.submit(fetch_racelist_task,*t):t for t in past_meta_tasks}
            for fut in as_completed(futs):
                code,hd,rno=futs[fut]
                try:
                    _,_,meta,err=fut.result()
                except Exception as e:
                    meta,err=[],f"{type(e).__name__}: {e}"
                past_meta_results[(code,hd,rno)]=(meta,err)

        for m in meetings:
            for d in m.get("meetDays",[]):
                for r in d.get("races",[]):
                    key=(m["venueCode"],d.get("date"),int(r.get("raceNo") or 0))
                    meta,err=past_meta_results.get(key,([],None))
                    if meta:
                        merge_racelist_meta_into_race(r,meta,racer_cache)
                    elif err:
                        r.setdefault("errors",{})["racelist"]=err

    # 過去開催日の結果を取得。節間成績の「進入コース」補完と、
    # 節間成績から過去レース結果へ遷移するために保存する。
    past_result_tasks=[]
    for m in meetings:
        for d in m.get("meetDays",[]):
            if d.get("date") and d["date"] < m.get("date",""):
                for r in d.get("races",[]):
                    rno=int(r.get("raceNo") or 0)
                    if rno:
                        past_result_tasks.append((m["venueCode"],d["date"],rno))

    if past_result_tasks:
        print(f"[BOAT CHECK] ENRICH past-result tasks={len(past_result_tasks)}")
        exact_result_map={}
        with ThreadPoolExecutor(max_workers=min(max(workers,12),16)) as ex:
            futs={ex.submit(fetch_result_task,*t):t for t in past_result_tasks}
            for fut in as_completed(futs):
                code,hd,rno=futs[fut]
                try:
                    _,_,data,err=fut.result()
                except Exception as e:
                    data,err={},f"{type(e).__name__}: {e}"
                exact_result_map[(code,hd,rno)]=(data,err)

        for m in meetings:
            for d in m.get("meetDays",[]):
                for r in d.get("races",[]):
                    key=(m["venueCode"],d.get("date"),int(r.get("raceNo") or 0))
                    data,err=exact_result_map.get(key,({},None))
                    if data:
                        r["result"]=data
                        r["resultUpdatedAt"]=datetime.now(JST).isoformat(timespec="seconds")
                    elif err:
                        r.setdefault("errors",{})["result"]=err

        # Historical results contain actual start-order course values. Re-merge them
        # into the current six racers so missing course cells are filled.
        for m in meetings:
            ref=ref_results.get(m["venueCode"],{})
            apply_meeting_series_data(m,ref.get("point",{}),ref.get("pre",{}),ref.get("info",{}))

    # 現在日の出走表をmeetDaysにも反映
    for m in meetings:
        for d in m.get("meetDays",[]):
            if d.get("date") == m.get("date"):
                d["races"] = m.get("races",[])

    # 同一開催の別日表示でも、選手の基本プロフィールが空白にならないように
    # 登録番号をキーに最も情報量の多いレコードを共有する。
    for m in meetings:
        registry_by_id={}
        registry_by_name={}

        all_races=list(m.get("races",[]) or [])
        for d in m.get("meetDays",[]) or []:
            all_races.extend(d.get("races",[]) or [])

        for r in all_races:
            for b in r.get("boats",[]) or []:
                rid=str(b.get("racerId") or b.get("registrationNo") or "")
                name_key=_merge_racer_name_key(b.get("racerName"))
                richness=sum(
                    1 for k in (
                        "racerId","branch","origin","period","age","weight",
                        "flyingCount","lateCount","avgST","stats","meetResults","meetStats"
                    )
                    if b.get(k) not in (None,"",[],{})
                )
                if rid:
                    old=registry_by_id.get(rid)
                    if old is None or richness>old[0]:
                        registry_by_id[rid]=(richness,b)
                if name_key:
                    old=registry_by_name.get(name_key)
                    if old is None or richness>old[0]:
                        registry_by_name[name_key]=(richness,b)

        share_keys=(
            "racerId","registrationNo","class","branch","origin","period","age",
            "flyingCount","lateCount","avgST","nationalWinRate","national2Rate","national3Rate",
            "localWinRate","local2Rate","local3Rate","stats","meetResults","meetStats"
        )
        for r in all_races:
            for b in r.get("boats",[]) or []:
                rid=str(b.get("racerId") or b.get("registrationNo") or "")
                name_key=_merge_racer_name_key(b.get("racerName"))
                src_pair=registry_by_id.get(rid) if rid else None
                if src_pair is None and name_key:
                    src_pair=registry_by_name.get(name_key)
                if not src_pair:
                    continue
                src=src_pair[1]
                for k in share_keys:
                    if b.get(k) in (None,"",[],{}) and src.get(k) not in (None,"",[],{}):
                        try:
                            b[k]=json.loads(json.dumps(src[k],ensure_ascii=False))
                        except Exception:
                            b[k]=src[k]

    # 未取得の登録期だけprofile取得
    all_profile_boats=[]
    for m in meetings:
        for r in m.get("races",[]) or []:
            all_profile_boats.extend(r.get("boats",[]) or [])
        for d in m.get("meetDays",[]) or []:
            for r in d.get("races",[]) or []:
                all_profile_boats.extend(r.get("boats",[]) or [])

    ids = {
        str(b.get("racerId"))
        for b in all_profile_boats
        if b.get("racerId")
    }
    missing = sorted(rid for rid in ids if not racer_cache.get(rid,{}).get("period"))
    print(f"[BOAT CHECK] ENRICH profile cache misses={len(missing)}")
    if missing:
        with ThreadPoolExecutor(max_workers=min(workers,10)) as ex:
            futs = [ex.submit(fetch_profile_period,rid) for rid in missing]
            for fut in as_completed(futs):
                rid, info=fut.result()
                old_info=racer_cache.get(rid,{}) or {}
                merged_info=dict(old_info)
                merged_info.update({k:v for k,v in info.items() if v not in (None,"")})
                racer_cache[rid]=merged_info

    for b in all_profile_boats:
        rid=str(b.get("racerId",""))
        info=racer_cache.get(rid,{}) or {}

        if info.get("period"):
            b["period"]=info["period"]
        if not b.get("branch") and info.get("branch"):
            b["branch"]=info["branch"]
        if not b.get("origin") and info.get("origin"):
            b["origin"]=info["origin"]
        if b.get("weight") in (None,"") and info.get("weight") is not None:
            b["weight"]=info["weight"]
        if not b.get("class") and info.get("class"):
            b["class"]=info["class"]

    cache_path.parent.mkdir(parents=True,exist_ok=True)
    cache_path.write_text(json.dumps(racer_cache,ensure_ascii=False,indent=2),encoding="utf-8")


def _result_archive_entries(payload: dict) -> list[dict]:
    out=[]
    for m in payload.get("meetings",[]) or []:
        venue_code=str(m.get("venueCode") or "")
        venue_name=m.get("venueName") or ""
        meeting_title=m.get("title") or m.get("eventTitle") or ""

        sources=[]
        if m.get("date"):
            sources.append((m.get("date"),m.get("races",[]) or []))
        for d in m.get("meetDays",[]) or []:
            if d.get("date"):
                sources.append((d.get("date"),d.get("races",[]) or []))

        seen=set()
        for day_date,races in sources:
            for r in races:
                rno=int(r.get("raceNo") or 0)
                key=(str(day_date),rno)
                if not day_date or not rno or key in seen:
                    continue
                seen.add(key)
                result=r.get("result") or r.get("raceResult") or {}
                if result.get("official") is not True:
                    continue
                out.append({
                    "venueCode":venue_code,
                    "venueName":venue_name,
                    "meetingTitle":meeting_title,
                    "date":str(day_date),
                    "raceNo":rno,
                    "result":result,
                    "resultUpdatedAt":r.get("resultUpdatedAt"),
                })
    return out

def build_recent_results(old_payload: dict, payload: dict, keep_days: int=3) -> list[dict]:
    items=[]
    items.extend(old_payload.get("recentResults",[]) or [])
    items.extend(_result_archive_entries(old_payload))
    items.extend(_result_archive_entries(payload))

    latest={}
    for x in items:
        code=str(x.get("venueCode") or "")
        date=str(x.get("date") or "")
        rno=int(x.get("raceNo") or 0)
        result=x.get("result") or {}
        if not code or not re.fullmatch(r"\d{8}",date) or not rno or result.get("official") is not True:
            continue
        latest[(code,date,rno)]=x

    today=datetime.now(JST).date()
    kept=[]
    for (code,date,rno),x in latest.items():
        try:
            d=datetime.strptime(date,"%Y%m%d").date()
            age=(today-d).days
        except Exception:
            continue
        if 0 <= age <= keep_days:
            kept.append(x)

    kept.sort(key=lambda x:(x.get("date",""),int(x.get("venueCode") or 0),int(x.get("raceNo") or 0)))
    return kept

def collect(date: str, out_path: Path, enrich: bool, live: bool, workers: int) -> dict:
    old_payload = load_json(out_path, {})
    racer_cache = load_json(out_path.parent/"racers.json", {})
    old_map = old_meeting_map(old_payload)

    venues = active_venues(date)
    print(f"[BOAT CHECK] date={date} active={len(venues)} mode={'ENRICH' if enrich else ('LIVE' if live else 'FAST')}")

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

    now_jst=datetime.now(JST)
    static_enriched_date = old_payload.get("staticEnrichedDate") if old_payload.get("dateJST")==date else None

    # First live job after midnight also performs the full static enrichment.
    # If that run fails to commit, subsequent live jobs retry until 03:00 JST.
    rollover_enrich = bool(
        live
        and meetings
        and now_jst.hour < 3
        and static_enriched_date != date
    )

    payload = {
        "schemaVersion":"50.0",
        "updatedAt":now_jst.isoformat(timespec="seconds"),
        "dateJST":date,
        "source":"BOAT RACE official public pages",
        "mode":"enrich" if enrich else ("rollover-enrich" if rollover_enrich else ("live" if live else "fast")),
        "staticEnrichedDate": static_enriched_date,
        "meetings":meetings,
        "errors":errors,
    }

    if (enrich or rollover_enrich) and meetings:
        if rollover_enrich:
            print("[BOAT CHECK] JST date rollover detected -> full enrichment now")
        enrich_payload(payload,out_path.parent/"racers.json",workers=workers)
        payload["staticEnrichedDate"]=date
        payload["staticEnrichedAt"]=datetime.now(JST).isoformat(timespec="seconds")
        if rollover_enrich:
            payload["rolloverEnriched"]=True
    elif old_payload.get("dateJST")==date and old_payload.get("staticEnrichedAt"):
        payload["staticEnrichedAt"]=old_payload.get("staticEnrichedAt")

    if meetings:
        enrich_realtime(payload,workers=workers,live=live)

    payload["recentResults"]=build_recent_results(old_payload,payload,keep_days=3)

    return payload

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--date",default=None,help="YYYYMMDD。省略時は日本時間の今日")
    p.add_argument("--out",default="data/today.json")
    p.add_argument("--enrich",action="store_true",help="全R出走表に加え、今節成績/得点率/前検/モーター・ボート基本値を取得")
    p.add_argument("--deep",action="store_true",help="旧互換: --enrich と同じ")
    p.add_argument("--live",action="store_true",help="5分更新用: 直前展示と直近の結果・払戻を優先取得")
    p.add_argument("--workers",type=int,default=10)
    args=p.parse_args()

    date=args.date or datetime.now(JST).strftime("%Y%m%d")
    out_path=Path(args.out)
    enrich=bool(args.enrich or args.deep)
    live=bool(args.live and not enrich)

    payload=collect(date,out_path,enrich,live,args.workers)
    out_path.parent.mkdir(parents=True,exist_ok=True)
    out_path.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"[BOAT CHECK] collected {len(payload['meetings'])} meetings -> {out_path}")

    if not payload["meetings"]:
        raise SystemExit("No meetings collected.")

if __name__=="__main__":
    main()
