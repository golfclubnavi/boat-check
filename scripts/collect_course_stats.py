#!/usr/bin/env python3
"""Attach each active racer's recent results, grouped up to 20 per entry course."""
from __future__ import annotations

import argparse
import io
import json
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import lhafile
import requests


JST_RESULT_BASE = "https://www1.mbrace.or.jp/od2/K"
VENUES = {
    "01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
    "07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
    "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
    "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
}
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; BOAT-CHECK/0.57)"}
RACER_ROW = re.compile(
    r"^\s*(\S+)\s+([1-6])\s+(\d{4})\s+(.+?)\s+"
    r"(\d{1,3})\s+(\d{1,3})\s+(\d+\.\d+)\s+([1-6])\s+([FL]?\s*\d+\.\d+)"
)
RACE_HEAD = re.compile(r"^\s*(\d{1,2})R\s+.*?H\d+m\b")
VENUE_BEGIN = re.compile(r"^(\d{2})KBGN\s*$")
FINISH_NUM = re.compile(r"^0?([1-6])$")


def archive_url(day: date) -> str:
    yy = day.strftime("%y%m%d")
    return f"{JST_RESULT_BASE}/{day:%Y%m}/k{yy}.lzh"


def download_day(day: date, timeout: int = 30) -> tuple[date, bytes | None, str | None]:
    try:
        res = requests.get(archive_url(day), headers=HEADERS, timeout=timeout)
        if res.status_code == 404:
            return day, None, "not-published"
        res.raise_for_status()
        return day, res.content, None
    except Exception as exc:
        return day, None, f"{type(exc).__name__}: {exc}"


def decode_archive(blob: bytes) -> str:
    archive = lhafile.Lhafile(io.BytesIO(blob))
    names = archive.namelist()
    if not names:
        return ""
    return archive.read(names[0]).decode("cp932", "replace")


def grade_from_text(text: str) -> str:
    t = text.upper().replace("Ｇ", "G").replace("Ⅰ", "1").replace("Ⅱ", "2").replace("Ⅲ", "3")
    if "SG" in t:
        return "SG"
    if re.search(r"\bG1\b|開設.{0,10}周年", t):
        return "G1"
    if re.search(r"\bG2\b|モーターボート大賞", t):
        return "G2"
    if re.search(r"\bG3\b|オールレディース|マスターズリーグ", t):
        return "G3"
    return "一般"


def normalize_name(value: str) -> str:
    return re.sub(r"[\s　]+", " ", value).strip()


def parse_day(text: str, day: date, wanted: set[str]) -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = defaultdict(list)
    venue_code = ""
    race_no = 0
    race_head = ""
    race_move = ""
    event_context = ""
    race_rows: list[dict] = []

    def finish_race() -> None:
        nonlocal race_rows
        if not venue_code or not race_no or not race_rows:
            race_rows = []
            return
        numeric = []
        for row in race_rows:
            match = FINISH_NUM.match(row["finishRaw"])
            if match:
                numeric.append((int(match.group(1)), row["lane"]))
        numeric.sort()
        result = [lane for _, lane in numeric[:3]]
        move = race_move
        grade = grade_from_text(event_context + " " + race_head)
        valid_st=[float(r["st"]) for r in race_rows if r["finishRaw"] not in {"F","L","K","欠"} and re.fullmatch(r"0\.\d+",r["st"]) ]
        displays=[r["exhibitionTime"] for r in race_rows if 5<r["exhibitionTime"]<9]
        winner=next((r for r in race_rows if FINISH_NUM.match(r["finishRaw"]) and int(r["finishRaw"])==1),{})
        for row in race_rows:
            normal=row["finishRaw"] not in {"F","L","K","欠"} and re.fullmatch(r"0\.\d+",row["st"])
            row["normalST"]=float(row["st"]) if normal else None
            row["stRank"]=1+sum(v<float(row["st"]) for v in valid_st) if normal else None
            row["displayRank"]=1+sum(v<row["exhibitionTime"] for v in displays) if 5<row["exhibitionTime"]<9 else None
            row["winnerCourse"]=winner.get("course")
            row["raceMove"]=move
            racer_id = row.pop("racerId")
            raw_finish = row.pop("finishRaw")
            match = FINISH_NUM.match(raw_finish)
            row.update({
                "date": day.isoformat(),
                "venueCode": venue_code,
                "venueName": VENUES.get(venue_code, venue_code),
                "grade": grade,
                "raceNo": race_no,
                "finish": int(match.group(1)) if match else raw_finish,
                "kimarite": move if match and int(match.group(1)) == 1 else "",
                "result": result,
            })
            if racer_id in wanted:
                found[racer_id].append(row)
        race_rows = []

    lines = text.splitlines()
    for line in lines:
        begin = VENUE_BEGIN.match(line)
        if begin:
            finish_race()
            venue_code = begin.group(1)
            race_no = 0
            event_context = ""
            continue
        if venue_code and ("［成績］" in line or "競走成績" in line or "第 " in line):
            event_context += " " + line.strip()
        head = RACE_HEAD.match(line)
        if head:
            finish_race()
            race_no = int(head.group(1))
            race_head = line
            race_move = ""
            continue
        if race_no and "ﾚｰｽﾀｲﾑ" in line:
            move_match = re.search(r"(まくり差し|逃げ|差し|まくり|抜き|恵まれ)", line)
            race_move = move_match.group(1) if move_match else ""
            continue
        if not race_no:
            continue
        match = RACER_ROW.match(line)
        if not match:
            continue
        finish_raw, lane, racer_id, name, _motor, _boat, exhibition, course, start = match.groups()
        start = start.replace(" ", "")
        race_rows.append({
            "racerId": racer_id,
            "racerName": normalize_name(name),
            "finishRaw": finish_raw,
            "lane": int(lane),
            "course": int(course),
            "exhibitionTime": float(exhibition),
            "st": start,
        })
    finish_race()
    return found


def current_racers(payload: dict) -> set[str]:
    racers: set[str] = set()
    for meeting in payload.get("meetings", []) or []:
        for race in meeting.get("races", []) or []:
            for boat in race.get("boats", []) or []:
                racer_id = str(boat.get("racerId") or boat.get("registrationNo") or "")
                if racer_id:
                    racers.add(racer_id)
    return racers



def subtract_months(d,months):
    import calendar
    y,m=divmod(d.year*12+d.month-1-months,12)
    return date(y,m+1,min(d.day,calendar.monthrange(y,m+1)[1]))

def aggregate(rows,base):
    from statistics import mean
    output={str(c):{} for c in range(1,7)}
    for period,months in [("m1",1),("m3",3),("m6",6),("y1",12)]:
        relevant=[r for r in rows if subtract_months(base,months).isoformat()<=r["date"]<base.isoformat()]
        for course in range(1,7):
            sample=[r for r in relevant if r["course"]==course];frames=[r for r in relevant if r["lane"]==course]
            n=len(sample)
            rate=lambda count: round(count*100/n,2) if n else None
            avg=lambda key: round(mean(vals),3) if (vals:=[r[key] for r in sample if r[key] is not None]) else None
            metrics={"entryCount":n,"winRate":rate(sum(r["finish"]==1 for r in sample)),"twoRate":rate(sum(r["finish"] in (1,2) for r in sample)),"threeRate":rate(sum(r["finish"] in (1,2,3) for r in sample)),"frameWinRate":round(sum(r["finish"]==1 for r in frames)*100/len(frames),2) if frames else None,"avgST":avg("normalST"),"stRank":avg("stRank"),"displayRank":avg("displayRank")}
            k={}
            for key,move in [("escape","逃げ"),("sashi","差し"),("makuri","まくり"),("makuriSashi","まくり差し"),("nuki","抜き")]:
                count=sum(r["finish"]==1 and r["raceMove"]==move for r in sample);k[key]=rate(count);k[key+"Count"]=count if n else None
            for key,move in [("passed","差し"),("makurare","まくり"),("makurareSashi","まくり差し")]:
                k[key]=rate(sum(r["finish"]!=1 and r["winnerCourse"] is not None and r["raceMove"]==move for r in sample))
            k["nigashi"]=rate(sum(r["winnerCourse"]==1 and r["raceMove"]=="逃げ" for r in sample))
            metrics["kimarite"]=k;output[str(course)][period]=metrics
    return output

def main():
    import time
    p=argparse.ArgumentParser();p.add_argument("--input",default="data/today.json");p.add_argument("--out",default="data/course-stats.json");p.add_argument("--cache",default=".cache/course-results");p.add_argument("--workers",type=int,default=10);args=p.parse_args()
    payload=json.loads(Path(args.input).read_text());wanted=current_racers(payload);base=datetime.strptime(payload["dateJST"],"%Y%m%d").date();first=subtract_months(base,12)
    days=[first+timedelta(days=i) for i in range((base-first).days)];cache=Path(args.cache);cache.mkdir(parents=True,exist_ok=True)
    def task(day):
        path=cache/f"k{day:%y%m%d}.lzh"
        if path.exists():blob=path.read_bytes();err=None
        else:
            _,blob,err=download_day(day,20)
            if blob:
                try:decode_archive(blob)
                except Exception as exc:return day,None,str(exc)
                path.write_bytes(blob)
        if not blob:return day,None,err
        try:return day,parse_day(decode_archive(blob),day,wanted),None
        except Exception as exc:return day,None,str(exc)
    history=defaultdict(list);errors=[];good=0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures=[ex.submit(task,day) for day in days]
        for i,f in enumerate(as_completed(futures),1):
            day,data,err=f.result()
            if data is not None:
                good+=1
                for rid,rows in data.items():history[rid].extend(rows)
            else:errors.append({"date":day.isoformat(),"error":err})
            if i%30==0:print(f"course history: {i}/{len(days)} days, success={good}, errors={len(errors)}",flush=True)
    for item in list(errors):
        day=datetime.strptime(item["date"],"%Y-%m-%d").date();_,data,err=task(day)
        if data is not None:
            errors.remove(item);good+=1
            for rid,rows in data.items():history[rid].extend(rows)
    out={"schemaVersion":1,"targetDateJST":payload["dateJST"],"from":first.isoformat(),"to":(base-timedelta(days=1)).isoformat(),"source":"BOAT RACE official result download files","daysExpected":len(days),"daysCollected":good,"errors":errors,"racerCount":len(wanted),"raceRows":sum(map(len,history.values())),"byRacer":{rid:aggregate(history[rid],base) for rid in sorted(wanted)}}
    path=Path(args.out);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(out,ensure_ascii=False,separators=(",",":")))
    print(json.dumps({k:v for k,v in out.items() if k!="byRacer"},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
