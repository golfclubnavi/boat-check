#!/usr/bin/env python3
"""Collect each active racer's recent results, grouped up to 30 per entry course."""
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


def normalize_finish(value: str) -> int | str:
    """Convert official result codes to short labels used by BOAT CHECK."""
    raw = re.sub(r"[\s　]+", "", str(value or "")).upper()
    match = FINISH_NUM.match(raw)
    if match:
        return int(match.group(1))
    if raw.startswith("S1") or "転" in raw:
        return "転"
    if raw.startswith("S") or "失" in raw:
        return "失"
    if raw.startswith("K") or "欠" in raw:
        return "欠"
    if raw.startswith("F") or "フライング" in raw:
        return "F"
    if raw.startswith("L") or "出遅" in raw:
        return "L"
    return raw or "--"


def start_order_value(value: str) -> float | None:
    """Return a sortable actual-start value; F is early and L is late."""
    raw = re.sub(r"[\s　]+", "", str(value or "")).upper()
    try:
        if raw.startswith("F"):
            return -abs(float(raw[1:]))
        if raw.startswith("L"):
            return 1.0 + abs(float(raw[1:]))
        return float(raw)
    except ValueError:
        return None


def attach_start_ranks(rows: list[dict]) -> None:
    starts = []
    for row in rows:
        value = start_order_value(row.get("st", ""))
        if value is not None:
            starts.append((value, int(row.get("lane") or 0)))
    starts.sort(key=lambda item: (item[0], item[1]))
    ranks: dict[int, int] = {}
    previous: float | None = None
    previous_rank = 0
    for index, (value, lane) in enumerate(starts, 1):
        rank = previous_rank if previous is not None and abs(value - previous) < 1e-9 else index
        ranks[lane] = rank
        previous = value
        previous_rank = rank
    for row in rows:
        row["stRank"] = ranks.get(int(row.get("lane") or 0))


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
        attach_start_ranks(race_rows)
        for row in race_rows:
            racer_id = row.pop("racerId")
            raw_finish = row.pop("finishRaw")
            match = FINISH_NUM.match(raw_finish)
            row.update({
                "date": day.isoformat(),
                "venueCode": venue_code,
                "venueName": VENUES.get(venue_code, venue_code),
                "grade": grade,
                "raceNo": race_no,
                "finish": normalize_finish(raw_finish),
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


def attach(payload: dict, history: dict[str, list[dict]]) -> None:
    # Store one canonical history per racer. Repeating the same 120 rows on every
    # race entry can push today.json close to GitHub's 100 MB file limit.
    payload["recent20ByRacer"] = history
    for meeting in payload.get("meetings", []) or []:
        sources = list(meeting.get("races", []) or [])
        for meet_day in meeting.get("meetDays", []) or []:
            sources.extend(meet_day.get("races", []) or [])
        for race in sources:
            for boat in race.get("boats", []) or []:
                boat.pop("recent20", None)


def compact_payload(payload: dict, history: dict[str, list[dict]], audit: dict) -> dict:
    venue_names: dict[str, str] = {}
    grades: list[str] = []
    moves: list[str] = [""]

    def value_index(values: list[str], value: str) -> int:
        value = value or ""
        if value not in values:
            values.append(value)
        return values.index(value)

    by_racer = {}
    for racer_id, rows in history.items():
        packed = []
        for row in rows:
            venue_code = str(row.get("venueCode") or "").zfill(2)
            venue_names[venue_code] = row.get("venueName") or "--"
            date_text = str(row.get("date") or "").replace("-", "")
            packed.append([
                date_text[2:8], venue_code,
                value_index(grades, row.get("grade") or "一般"),
                row.get("raceNo") or 0, row.get("lane") or 0,
                row.get("course") or 0, row.get("finish", "--"),
                value_index(moves, row.get("kimarite") or ""),
                "".join(str(x) for x in (row.get("result") or [])),
                row.get("exhibitionTime"), row.get("st"), row.get("stRank"),
            ])
        by_racer[racer_id] = packed
    return {
        "schemaVersion": 3,
        "compact": True,
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": "BOAT RACE official result download files",
        "targetDateJST": payload.get("dateJST"),
        "audit": audit,
        "venueNames": venue_names,
        "grades": grades,
        "kimarite": moves,
        "byRacer": by_racer,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--per-course", type=int, default=30)
    args = parser.parse_args()

    input_path = Path(args.input)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    wanted = current_racers(payload)
    base = datetime.strptime(str(payload.get("dateJST")), "%Y%m%d").date()
    days = [base - timedelta(days=i) for i in range(1, args.days + 1)]
    print(f"[recent20] racers={len(wanted)} lookback={len(days)} days")

    daily: dict[date, bytes] = {}
    errors = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 24))) as executor:
        futures = [executor.submit(download_day, day) for day in days]
        for index, future in enumerate(as_completed(futures), 1):
            day, blob, error = future.result()
            if blob:
                daily[day] = blob
            elif error != "not-published":
                errors.append({"date": day.isoformat(), "error": error})
            if index % 30 == 0:
                print(f"[recent20] downloaded {index}/{len(days)}")

    all_rows: dict[str, list[dict]] = defaultdict(list)
    for day in sorted(daily, reverse=True):
        parsed = parse_day(decode_archive(daily[day]), day, wanted)
        for racer_id, rows in parsed.items():
            all_rows[racer_id].extend(rows)

    selected: dict[str, list[dict]] = {}
    for racer_id in wanted:
        counts: dict[int, int] = defaultdict(int)
        rows = []
        for row in all_rows.get(racer_id, []):
            course = int(row.get("course") or 0)
            if course not in range(1, 7) or counts[course] >= args.per_course:
                continue
            counts[course] += 1
            rows.append(row)
        if rows:
            selected[racer_id] = rows

    coverage = {
        str(course): sum(
            1 for racer_id in wanted
            if sum(1 for row in selected.get(racer_id, []) if row.get("course") == course) >= args.per_course
        )
        for course in range(1, 7)
    }
    audit = {
        "targetRacers": len(wanted),
        "racersWithData": len(selected),
        "lookbackDays": args.days,
        "downloadedDays": len(daily),
        "perCourseTarget": args.per_course,
        "fullCoverageRacersByCourse": coverage,
        "downloadErrors": errors,
    }
    output = compact_payload(payload, selected, audit)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[recent20] racers with data={len(selected)}/{len(wanted)} -> {out_path}")
    print(f"[recent20] full coverage by course={coverage}")


if __name__ == "__main__":
    main()
