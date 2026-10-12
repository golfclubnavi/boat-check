#!/usr/bin/env python3
"""Offline collector regression tests: real task selection/application, stubbed HTTP."""
import ast
import contextlib
import copy
import io
import re
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

JST = ZoneInfo('Asia/Tokyo')
NOW = datetime(2026, 10, 12, 17, 4, tzinfo=JST)
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)

NAMES = {'_minutes_from_now', '_retry_due', '_before_complete', '_merge_before_rows', 'enrich_realtime', 'merge_boat_details'}
source = ast.parse(Path(__file__).with_name('collect_today.py').read_text())
module = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in NAMES], type_ignores=[])

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.before = {'boats': [{'lane':i,'exhibitionTime':6.7,'course':i,'st':'.09'} for i in range(1,7)],
                       'startExhibition':[{'lane':i,'course':i,'st':'.09'} for i in range(1,7)]}
        self.odds = {'official':True, **{k:[{'combination':'1','odds':2.5}] for k in ('trifecta','trio','exacta','quinella','wide','win','place')}}
        self.error = None
        self.env = dict(datetime=Clock, JST=JST, re=re, ThreadPoolExecutor=ThreadPoolExecutor, as_completed=as_completed,
                        LIVE_RECOVERY_MINUTES=120, ODDS_KINDS=tuple(k for k in self.odds if k!='official'),
                        _result_refresh_due=lambda *a:False, _local_url_candidates=lambda *a:[],
                        fetch_point_rank_task=lambda code,date:(code,{},None), apply_meeting_series_data=lambda *a,**k:None,
                        apply_equipment_ranks=lambda *a:None)
        for kind in ('beforeinfo','odds'):
            def fetch(code,date,rno,kind=kind):
                self.calls.append((kind,code,date,rno))
                return code,rno,copy.deepcopy(self.before if kind=='beforeinfo' else self.odds),self.error
            self.env['fetch_'+kind+'_task'] = fetch
        exec(compile(module,'collector-selected-functions','exec'),self.env)
    def payload(self, late=39):
        deadline=(NOW-timedelta(minutes=late)).strftime('%H:%M')
        return {'dateJST':'20261012','meetings':[{'venueCode':'03','date':'20261012','races':[{'raceNo':12,'deadline':deadline,'boats':[{'lane':i,'actualST':'.15'} for i in range(1,7)]}]}]}
    def run_live(self,p):
        with contextlib.redirect_stdout(io.StringIO()):self.env['enrich_realtime'](p,live=True)
    def test_closed_missing_11_26_39(self):
        for late in (11,26,39):
            with self.subTest(late=late):
                self.calls=[];p=self.payload(late);self.run_live(p);r=p['meetings'][0]['races'][0]
                self.assertEqual({c[0] for c in self.calls},{'odds','beforeinfo'})
                self.assertTrue(self.env['_before_complete'](r));self.assertEqual(len(r['odds']['updatedAtByType']),7)
                self.assertTrue(all(b['actualST']=='.15' and b['exhibitionST']=='.09' for b in r['boats']))
    def test_day_venue_race_and_recovery_bound(self):
        for date in ('20261011','20261013'):
            p=self.payload();p['dateJST']=date;self.run_live(p)
            p=self.payload();p['meetings'][0]['date']=date;self.run_live(p)
        p=self.payload(121);self.run_live(p)
        self.assertFalse(self.calls)
    def test_failure_backoff_and_no_success_stamp(self):
        self.before={};self.odds={};self.error='HTTP failure';p=self.payload();self.run_live(p)
        r=p['meetings'][0]['races'][0]
        self.assertNotIn('oddsUpdatedAt',r);self.assertNotIn('beforeUpdatedAt',r)
        self.assertEqual(set(r['liveErrors']),{'odds','beforeinfo'})
        self.calls=[];self.run_live(p);self.assertFalse(self.calls)
        for key in ('beforeLastAttemptAt','oddsLastAttemptAt'):r[key]=(NOW-timedelta(minutes=10)).isoformat()
        self.run_live(p);self.assertEqual(len(self.calls),2)
    def test_complete_post_cutoff_not_refetched(self):
        p=self.payload();self.run_live(p);self.calls=[];r=copy.deepcopy(p['meetings'][0]['races'][0])
        self.run_live(p);self.assertFalse(self.calls);self.assertEqual(r['odds'],p['meetings'][0]['races'][0]['odds'])
    def test_partial_odds_preserve_each_timestamp(self):
        p=self.payload();r=p['meetings'][0]['races'][0];old='2026-10-12T16:00:00+09:00'
        r['odds']={'official':True,'trifecta':[{'odds':9}], 'updatedAtByType':{'trifecta':old}};r['oddsUpdatedAt']=old
        self.odds={'official':True,'trio':[{'odds':5}]};self.run_live(p)
        self.assertEqual(r['odds']['trifecta'],[{'odds':9}]);self.assertEqual(r['odds']['updatedAtByType']['trifecta'],old)
        self.assertEqual(r['odds']['updatedAtByType']['trio'],NOW.isoformat())
    def test_null_rows_never_erase_or_stamp(self):
        p=self.payload();r=p['meetings'][0]['races'][0];old='2026-10-12T16:00:00+09:00'
        r['beforeData']=[{'lane':1,'exhibitionTime':6.6,'st':'.05'}];r['beforeUpdatedAt']=old
        r['boats'][0]['before']={'exhibitionTime':6.6,'st':'.05'}
        self.before={'boats':[{'lane':1,'exhibitionTime':None,'st':None}], 'weather':{'windSpeed':None}}
        self.run_live(p);self.assertEqual(r['beforeUpdatedAt'],old);self.assertEqual(r['beforeData'][0]['st'],'.05')
        self.assertEqual(r['boats'][0]['before']['st'],'.05')
    def test_partial_before_merges_lane_values(self):
        p=self.payload();r=p['meetings'][0]['races'][0]
        r['beforeData']=[{'lane':1,'exhibitionTime':6.6,'st':'.05'}]
        r['startExhibition']=[{'lane':1,'course':1,'st':'.05'}]
        self.before={'boats':[{'lane':1,'exhibitionTime':None,'weight':52}], 'startExhibition':[{'lane':1,'course':None,'st':None},{'lane':2,'course':2,'st':'F.01'}]}
        self.run_live(p);self.assertEqual(r['beforeData'][0]['exhibitionTime'],6.6)
        self.assertEqual(r['startExhibition'][0]['st'],'.05');self.assertEqual(r['startExhibition'][1]['st'],'F.01')
    def test_official_flag_alone_not_success(self):
        p=self.payload();self.odds={'official':True};self.run_live(p)
        self.assertNotIn('oddsUpdatedAt',p['meetings'][0]['races'][0])
    def test_metadata_weather_only_not_success(self):
        p=self.payload();self.before={'boats':[{'lane':1,'weight':52,'racerName':'test','official':True}], 'weather':{'windSpeed':3}}
        self.run_live(p);r=p['meetings'][0]['races'][0]
        self.assertNotIn('beforeUpdatedAt',r);self.assertIn('beforeLastAttemptAt',r)
    def test_old_odds_without_timestamp(self):
        p=self.payload();r=p['meetings'][0]['races'][0];r['odds']={'official':True,'trifecta':[{'odds':9}]}
        self.odds={'official':True,'trio':[{'odds':5}]};self.run_live(p)
        self.assertEqual(r['odds']['trifecta'],[{'odds':9}]);self.assertNotIn('trifecta',r['odds']['updatedAtByType'])
    def test_cancelled_and_postponed_not_collected(self):
        for status in ('cancelled','postponed'):
            p=self.payload();p['meetings'][0]['races'][0]['status']=status;self.run_live(p)
            p=self.payload();p['meetings'][0]['status']=status;self.run_live(p)
        self.assertFalse(self.calls)
    def test_raceindex_preserves_start_exhibition(self):
        fresh=[{'raceNo':12,'boats':[]}];old=[{'raceNo':12,'startExhibition':[{'lane':1,'st':'.05'}],'boats':[]}]
        self.env['merge_boat_details'](fresh,old,{})
        self.assertEqual(fresh[0]['startExhibition'],old[0]['startExhibition'])

if __name__=='__main__':unittest.main()
