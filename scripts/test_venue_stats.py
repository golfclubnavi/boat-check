#!/usr/bin/env python3
"""Offline checks for venue statistics: parser reuse, denominators, page safety."""
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parent))
from build_venue_pages import MIN_RACES, build
from build_venue_stats import aggregate, summarize
from collect_course_stats import parse_day


def race(no,finishes,courses,move,sts):
    lines=[f'  {no:>2}R       予選                 H1800m  晴　 風  北東　 2m  波　  2cm',
           f'  着 艇 登番 　選　手　名　　ﾓｰﾀｰ ﾎﾞｰﾄ 展示 進入 ｽﾀｰﾄﾀｲﾐﾝｸ ﾚｰｽﾀｲﾑ {move}']
    for lane,(fin,course,st) in enumerate(zip(finishes,courses,sts),1):
        lines.append(f'  {fin:<3} {lane} {4000+lane} 選手{lane}　太郎   {10+lane:>2}   {20+lane:>2}  6.7{lane}   {course}    {st}     1.49.{lane}')
    return lines


def fixture():
    text=['01KBGN','第１回 テスト杯 ［成績］']
    text+=race(1,['01','02','03','04','05','06'],[1,2,3,4,5,6],'逃げ',['0.10','0.12','0.14','0.16','0.18','0.20'])
    # Lane 2 entered course 1 and won; lane 6 flew; lane 5 was absent.
    text+=race(2,['02','01','03','04','K0','F'],[2,1,3,4,5,6],'差し',['0.11','0.09','0.15','0.13','0.20','F0.01'])
    text+=['01KEND','24KBGN','第２回 テスト杯 ［成績］']
    text+=race(1,['04','03','01','02','05','06'],[1,2,3,4,5,6],'まくり',['0.20','0.18','0.08','0.15','0.17','0.19'])
    text+=['24KEND']
    return '\n'.join(text)


def main():
    day=date(2026,10,29)
    parsed=parse_day(fixture(),day,None)
    rows=[r for rs in parsed.values() for r in rs]
    assert len(rows)==18,len(rows)
    s=summarize([r for r in rows if r['venueCode']=='01'])
    assert s['races']==2
    one=s['courses']['1']
    assert one['starts']==2 and one['win']==100.0,one   # course, not lane, decides the bucket
    assert s['courses']['5']['starts']==1,'absent K0 must leave the denominator'
    six=s['courses']['6']
    assert six['starts']==2 and six['top3']==0.0,'F counts as a start but never as a finish'
    assert abs(one['avgST']-0.095)<1e-9 and six['avgST']==0.2,(one,six)
    assert s['kimarite']['逃げ']==1 and s['kimarite']['差し']==1
    periods=aggregate(rows,date(2026,10,30))
    assert periods['y1']['national']['races']==3 and set(periods['y1']['venues'])=={'01','24'}
    assert periods['y1']['national']['courses']['3']['win']==round(100/3,1)

    # Small samples produce no page and no links (no thin or empty URLs).
    stats={'targetDateJST':'20261030','daysExpected':365,'daysCollected':365,'venueNames':{'01':'桐生','24':'大村'},
           'generatedAt':'2026-10-30T08:00:00+09:00','periods':periods}
    with tempfile.TemporaryDirectory() as tmp:
        assert build(stats,tmp)==[] and not (Path(tmp)/'venues').exists()

    # Scale one venue above the threshold; the other stays unpublished.
    big=summarize([r for r in rows if r['venueCode']=='01'])
    big['races']=MIN_RACES
    stats['periods']['y1']['venues']['01']=big
    stats['venueNames']['02']='戸田<script>'
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp)
        (root/'sitemap.xml').write_text('<urlset>\n</urlset>')
        (root/'index.html').write_text('<a href="data-method.html"><strong>x</strong></a><footer class="siteFooter"><nav>\n    <a href="data-sources.html">データ出典</a>\n  </nav></footer>',encoding='utf-8')
        written=build(stats,tmp)
        assert written==['venues/index.html','venues/01.html'],written
        page=(root/'venues/01.html').read_text(encoding='utf-8')
        for needed in ('<link rel="canonical" href="https://boatcheck.jp/venues/01.html">','1コースの1着率は100.0%','枠番ではなく','次のレースの結果を保証しません','../legal.css'):
            assert needed in page,needed
        index=(root/'venues/index.html').read_text(encoding='utf-8')
        assert '大村' in index and '戸田&lt;script&gt;' in index and '<script>、' not in index
        assert not (root/'venues/24.html').exists()
        sitemap=(root/'sitemap.xml').read_text()
        assert 'https://boatcheck.jp/venues/</loc>' in sitemap and 'venues/01.html' in sitemap and 'venues/24.html' not in sitemap
        home=(root/'index.html').read_text(encoding='utf-8')
        assert home.count('href="venues/"')==2
        build(stats,tmp)
        assert (root/'index.html').read_text(encoding='utf-8').count('href="venues/"')==2,'re-run must not duplicate links'
    print('[venue] parser reuse, course denominators, F/K handling, threshold, escaping, sitemap/home links: OK')


if __name__=='__main__':main()
