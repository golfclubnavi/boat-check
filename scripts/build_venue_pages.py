#!/usr/bin/env python3
"""Render static venue statistics pages from data/venue-stats.json into a release.

Every sentence on a page is derived from the aggregated numbers; venues whose
sample is too small get no page, so no thin or empty URL is published.
"""
import html
import json
import sys
from pathlib import Path

MIN_RACES=300
ADS='<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9271224558105519" crossorigin="anonymous"></script>'
MOVES=('逃げ','差し','まくり','まくり差し','抜き','恵まれ')
esc=lambda v:html.escape(str(v),quote=True)
pct=lambda v:'--' if v is None else f'{v:.1f}%'
st=lambda v:'--' if v is None else f'{v:.2f}'.lstrip('0')
ymd=lambda s:f'{int(s[:4])}年{int(s[5:7])}月{int(s[8:10])}日'
share=lambda count,total:round(count*100/total,1) if total else None


def page(title,description,canonical,body,generated):
    return f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script src="../analytics.js" defer></script>{ADS}<meta name="description" content="{esc(description)}"><link rel="canonical" href="{esc(canonical)}"><title>{esc(title)}</title><link rel="stylesheet" href="../legal.css"><style>.stats{{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}}.stats th,.stats td{{padding:8px 6px;border:1px solid var(--line);text-align:right;white-space:nowrap}}.stats th{{background:#eef6fb;text-align:center}}.stats td:first-child{{text-align:center;font-weight:800}}.scroll{{overflow-x:auto;-webkit-overflow-scrolling:touch}}.facts li{{margin:4px 0}}</style></head><body><header><div class="head"><a class="brand" href="../index.html">BOAT <b>✓</b> CHECK</a><span>24場のコース別成績</span></div></header><main><a class="back" href="./">‹ 24場のコース別成績へ</a><article class="card">{body}<p class="meta">集計日時：{esc(generated)}　出典：BOAT RACE公式 競走成績ダウンロードファイル（BOAT CHECK独自集計）</p></article></main><footer><nav><a href="../index.html">開催一覧</a><a href="../data-method.html">データの読み方</a><a href="../data-sources.html">データ出典</a><a href="../about.html">サイトについて</a><a href="../operator.html">運営者</a></nav>BOAT CHECKはBOAT RACE公式サイトではありません。</footer></body></html>'''


def course_table(summary):
    rows=''.join(f'<tr><td>{c}</td><td>{v["starts"]:,}</td><td>{pct(v["win"])}</td><td>{pct(v["top2"])}</td><td>{pct(v["top3"])}</td><td>{st(v["avgST"])}</td></tr>'
                 for c,v in sorted(summary['courses'].items()))
    return f'<div class="scroll"><table class="stats"><tr><th>進入</th><th>出走数</th><th>1着率</th><th>2連対率</th><th>3連対率</th><th>平均ST</th></tr>{rows}</table></div>'


def kimarite_table(summary,national):
    rows=''.join(f'<tr><td>{m}</td><td>{summary["kimarite"][m]:,}</td><td>{pct(share(summary["kimarite"][m],summary["races"]))}</td><td>{pct(share(national["kimarite"][m],national["races"]))}</td></tr>' for m in MOVES)
    return f'<div class="scroll"><table class="stats"><tr><th>決まり手</th><th>回数</th><th>割合</th><th>全国</th></tr>{rows}</table></div>'


def venue_body(code,name,y1,m3,national,rank,count):
    one=y1['courses']['1'];n1=national['courses']['1']
    outer=max(((c,v) for c,v in y1['courses'].items() if c!='1' and v['win'] is not None),key=lambda x:x[1]['win'],default=None)
    top_move=max(MOVES,key=lambda m:y1['kimarite'][m])
    diff=None if m3 is None or m3['courses']['1']['win'] is None or one['win'] is None else round(m3['courses']['1']['win']-one['win'],1)
    grades='、'.join(f'{esc(g)} {n:,}' for g,n in sorted(y1['grades'].items(),key=lambda x:-x[1]))
    facts=[f'1コースの1着率は{pct(one["win"])}（{one["starts"]:,}走）で、ページを掲載している{count}場のうち高い方から{rank}番目です。全国の1コース1着率は{pct(n1["win"])}です。',
           f'最も多い決まり手は「{top_move}」で、決着した{y1["races"]:,}レースの{pct(share(y1["kimarite"][top_move],y1["races"]))}です。']
    if outer:facts.append(f'2〜6コースのうち1着率が最も高いのは{outer[0]}コースの{pct(outer[1]["win"])}です。')
    if diff is not None:facts.append(f'直近3か月の1コース1着率は{pct(m3["courses"]["1"]["win"])}（{m3["courses"]["1"]["starts"]:,}走）で、過去1年との差は{diff:+.1f}ポイントです。出走数が少ない期間ほど値は大きく動きます。')
    m3_section=f'<h2>直近3か月（{ymd(m3["from"])}〜{ymd(m3["to"])}）</h2><p>決着{m3["races"]:,}レース。季節や開催グレードの偏りで1年の値と差が出ることがあります。</p>{course_table(m3)}' if m3 and m3['races'] else ''
    return (f'<h1>{esc(name)}の進入コース別成績</h1><p class="lead">BOAT RACE公式の競走成績ファイルをBOAT CHECKが集計した、{esc(name)}の過去1年（{ymd(y1["from"])}〜{ymd(y1["to"])}）の結果です。決着した{y1["races"]:,}レースを対象にしています。</p>'
            f'<h2>集計から分かること</h2><ul class="facts">{"".join(f"<li>{f}</li>" for f in facts)}</ul>'
            f'<h2>進入コース別の成績（過去1年）</h2><p>「進入」は枠番ではなく、実際にスタートしたコースです。分母は、そのコースから出走した艇の数です（欠場を除き、フライング・出遅れ・失格は着外として含みます）。平均STはF・Lなどを除いた正常なスタートの平均です。</p>{course_table(y1)}'
            f'<h2>決まり手（過去1年）</h2><p>1着艇の決まり手を、決着したレース数に対する割合で示します。「全国」は同じ期間の全24場の値です。</p>{kimarite_table(y1,national)}'
            f'{m3_section}'
            f'<h2>数値を使うときの注意</h2><p>過去の傾向は次のレースの結果を保証しません。開催グレードや出場選手の顔ぶれ、季節、水面状況によって値は変わります。対象レースの内訳（成績ファイルの節名から判定）：{grades}。個々のレースでは、出走表・直前情報・進入の変化をあわせて確認してください。集計の考え方は<a href="../data-method.html">データの読み方と集計上の注意</a>、見送りを考える手順は<a href="../race-reading.html">レースを見送るための確認手順</a>をご覧ください。</p>'
            f'<p>当日の出走表は<a href="../index.html">開催一覧</a>から{esc(name)}を選んで確認できます。</p>')


def build(stats,outdir):
    y1=stats['periods']['y1'];m3=stats['periods'].get('m3',{});names=stats['venueNames'];national=y1['national']
    eligible=[c for c,v in y1['venues'].items() if v['races']>=MIN_RACES and v['courses']['1']['win'] is not None]
    if not eligible:return []
    order=sorted(eligible,key=lambda c:-y1['venues'][c]['courses']['1']['win'])
    folder=Path(outdir)/'venues';folder.mkdir(parents=True,exist_ok=True)
    generated=stats['generatedAt'][:16].replace('T',' ')
    written=[]
    for code in eligible:
        name=names.get(code,code)
        # Period dates live on the period; each venue page needs them alongside its numbers.
        v=dict(y1['venues'][code],**{'from':y1['from'],'to':y1['to']})
        recent=m3.get('venues',{}).get(code)
        recent=dict(recent,**{'from':m3['from'],'to':m3['to']}) if recent else None
        body=venue_body(code,name,v,recent,national,order.index(code)+1,len(order))
        title=f'{name}の進入コース別成績・決まり手（過去1年）｜BOAT CHECK'
        desc=f'{name}の過去1年{v["races"]:,}レースを公式成績から独自集計。1コース1着率{pct(v["courses"]["1"]["win"])}、進入コース別の連対率・平均ST・決まり手を全国値と比較できます。'
        (folder/f'{code}.html').write_text(page(title,desc,f'https://boatcheck.jp/venues/{code}.html',body,generated),encoding='utf-8')
        written.append(f'venues/{code}.html')
    rows=''.join(f'<tr><td><a href="{c}.html">{esc(names.get(c,c))}</a></td><td>{y1["venues"][c]["races"]:,}</td><td>{pct(y1["venues"][c]["courses"]["1"]["win"])}</td><td>{pct(share(y1["venues"][c]["kimarite"]["逃げ"],y1["venues"][c]["races"]))}</td><td>{pct(y1["venues"][c]["courses"]["6"]["top3"])}</td></tr>' for c in sorted(eligible))
    missing=[names.get(c,c) for c in sorted(names) if c not in eligible]
    note=f'<p>対象期間の決着レースが{MIN_RACES}未満の場（{"、".join(map(esc,missing))}）は、値が安定しないためページを作成していません。</p>' if missing else ''
    body=(f'<h1>24場の進入コース別成績</h1><p class="lead">BOAT RACE公式の競走成績ファイルを、BOAT CHECKがレース場・進入コースごとに集計しました。対象は過去1年（{ymd(y1["from"])}〜{ymd(y1["to"])}）の決着した{national["races"]:,}レースです。</p>'
          f'<h2>場ごとの比較</h2><p>1コース1着率、逃げで決まった割合、6コースの3連対率を並べています。場名を選ぶと、コース別の連対率・平均ST・決まり手と直近3か月の値を確認できます。</p><div class="scroll"><table class="stats"><tr><th>場</th><th>レース数</th><th>1コース1着率</th><th>逃げ割合</th><th>6コース3連対率</th></tr>{rows}<tr><td>全国</td><td>{national["races"]:,}</td><td>{pct(national["courses"]["1"]["win"])}</td><td>{pct(share(national["kimarite"]["逃げ"],national["races"]))}</td><td>{pct(national["courses"]["6"]["top3"])}</td></tr></table></div>{note}'
          f'<h2>集計方法</h2><p>進入は枠番ではなく実際のスタートコースです。率の分母はそのコースから出走した艇の数で、欠場は除き、フライング・出遅れ・失格は着外として含みます。成績ファイルを取得できなかった日（{stats["daysExpected"]-stats["daysCollected"]}日）は集計に含まれません。データは毎日更新します。</p>'
          f'<p>これらは過去の集計であり、次のレースの結果を示すものではありません。数値の読み方は<a href="../data-method.html">データの読み方と集計上の注意</a>をご覧ください。</p>')
    (folder/'index.html').write_text(page('24場の進入コース別成績（過去1年・独自集計）｜BOAT CHECK',
        f'全国24場の過去1年{national["races"]:,}レースを公式成績から独自集計。1コース1着率、逃げ割合、6コース3連対率を場ごとに比較できます。',
        'https://boatcheck.jp/venues/',body,generated),encoding='utf-8')
    written.insert(0,'venues/index.html')
    link_release(Path(outdir),written,stats['targetDateJST'])
    return written


def link_release(root,written,target):
    """Add the generated URLs to the release sitemap and the home page links."""
    lastmod=f'{target[:4]}-{target[4:6]}-{target[6:]}'
    sitemap=root/'sitemap.xml'
    if sitemap.exists():
        urls=''.join(f'  <url><loc>https://boatcheck.jp/{p.replace("index.html","")}</loc><lastmod>{lastmod}</lastmod></url>\n' for p in written)
        sitemap.write_text(sitemap.read_text().replace('</urlset>',urls+'</urlset>'))
    home=root/'index.html'
    if home.exists():
        text=home.read_text(encoding='utf-8')
        card='<a href="venues/"><strong>24場のコース別成績</strong><span>公式成績を独自集計した過去1年の1着率・連対率・決まり手</span></a>'
        anchor='<a href="data-method.html"><strong>'
        if card not in text and anchor in text:text=text.replace(anchor,card+anchor,1)
        foot='<a href="data-sources.html">データ出典</a>\n  </nav>'
        if 'href="venues/">24場' not in text.split('siteFooter')[-1] and foot in text:text=text.replace(foot,'<a href="data-sources.html">データ出典</a>\n    <a href="venues/">24場のコース別成績</a>\n  </nav>',1)
        home.write_text(text,encoding='utf-8')


def main():
    source=Path(sys.argv[1] if len(sys.argv)>1 else 'data/venue-stats.json');outdir=sys.argv[2] if len(sys.argv)>2 else 'cloudflare-dist'
    if not source.is_file():print('[venues] no venue-stats.json yet; no pages generated');return
    written=build(json.loads(source.read_text()),outdir)
    print(f'[venues] {len(written)} pages generated')


if __name__=='__main__':main()
