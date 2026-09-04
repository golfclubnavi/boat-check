#!/usr/bin/env python3
"""
BOAT CHECK v18 collector
BOAT RACE公式の公開レースページから、当日の開催場・12R・6艇の基本出走データを
data/today.json に保存するための土台。
※ HTML構造変更時は parser の調整が必要です。
"""
from __future__ import annotations
import argparse, json, re, time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

VENUES = {
"01":"桐生","02":"戸田","03":"江戸川","04":"平和島","05":"多摩川","06":"浜名湖",
"07":"蒲郡","08":"常滑","09":"津","10":"三国","11":"びわこ","12":"住之江",
"13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
"19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村"
}
BASE="https://www.boatrace.jp/owpc/pc/race/"
UA="BOAT-CHECK/0.18 (+personal project; respectful request rate)"

def fetch(path, **params):
    url=BASE+path+"?"+urlencode(params)
    req=Request(url,headers={"User-Agent":UA,"Accept-Language":"ja,en;q=0.8"})
    with urlopen(req,timeout=20) as r:
        return r.read().decode("utf-8","replace")

def clean(s):
    s=re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>"," ",s,flags=re.I)
    s=re.sub(r"<[^>]+>"," ",s)
    s=s.replace("&nbsp;"," ").replace("&#39;","'")
    return re.sub(r"\s+"," ",s).strip()

def parse_raceindex(html, code, date):
    text=clean(html)
    # Race index is the most stable lightweight source for deadline + six names/classes.
    races=[]
    for rno in range(1,13):
        # Capture from "nR HH:MM" until next race marker.
        m=re.search(rf"(?:^|\s){rno}R\s+(\d{{1,2}}:\d{{2}})([\s\S]*?)(?=\s{rno+1}R\s+\d{{1,2}}:\d{{2}}|$)",text)
        if not m: continue
        deadline, chunk=m.group(1),m.group(2)
        racers=re.findall(r"([一-龥々ヶぁ-んァ-ヶー\s]{2,18})\s+(A1|A2|B1|B2)",chunk)
        boats=[]
        for lane,(name,klass) in enumerate(racers[:6],1):
            boats.append({"lane":lane,"racerName":re.sub(r"\s+"," ",name).strip(),"class":klass})
        races.append({"raceNo":rno,"deadline":deadline,"boats":boats})
    return races

def enrich_racelist(html, race):
    text=clean(html)
    # Registration/class/name, F/L, avg ST, national/local and motor/boat stats.
    # Keep rawText too so no information is lost while parser coverage expands.
    race["rawOfficialText"]=text[:20000]
    ids=re.findall(r"\b(\d{4})\s*/\s*(A1|A2|B1|B2)\b",text)
    for i,(rid,klass) in enumerate(ids[:6]):
        if i < len(race["boats"]):
            race["boats"][i]["racerId"]=rid
            race["boats"][i]["class"]=klass
    return race

def collect(date, deep=False, delay=0.35):
    meetings=[]
    for code,name in VENUES.items():
        try:
            html=fetch("raceindex",hd=date,jcd=code)
            races=parse_raceindex(html,code,date)
            if not races:
                continue
            meeting={"venueCode":code,"venueName":name,"date":date,"status":"open","races":races}
            if deep:
                for race in meeting["races"]:
                    try:
                        h=fetch("racelist",hd=date,jcd=code,rno=race["raceNo"])
                        enrich_racelist(h,race)
                        time.sleep(delay)
                    except Exception as e:
                        race["fetchError"]=str(e)
            meetings.append(meeting)
            time.sleep(delay)
        except Exception:
            pass
    return {
        "schemaVersion":"18.0",
        "updatedAt":datetime.now().astimezone().isoformat(timespec="seconds"),
        "source":"BOAT RACE official public race pages",
        "meetings":meetings
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--date",default=datetime.now().strftime("%Y%m%d"))
    ap.add_argument("--deep",action="store_true",help="各レースの出走表も取得")
    ap.add_argument("--out",default="data/today.json")
    args=ap.parse_args()
    payload=collect(args.date,args.deep)
    out=Path(args.out); out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"{len(payload['meetings'])} venues -> {out}")

if __name__=="__main__":
    main()
