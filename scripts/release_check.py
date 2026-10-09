#!/usr/bin/env python3
"""Offline release invariants; run after cloudflare-build.sh."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT=Path('cloudflare-dist')


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links=[]
        self.assets=[]
        self.cards=[]
        self.canonical=[]
        self.descriptions=[]

    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag=='a' and a.get('href'):self.links.append(a['href'])
        if tag in ('script','img') and a.get('src'):self.assets.append(a['src'])
        if tag=='link' and a.get('href'):self.assets.append(a['href'])
        if tag=='div' and 'card off' in a.get('class','') and a.get('data-code'):
            self.cards.append(a['data-code'])
        if tag=='link' and a.get('rel')=='canonical':self.canonical.append(a.get('href'))
        if tag=='meta' and a.get('name')=='description':self.descriptions.append(a.get('content'))


def main():
    pages=list(ROOT.glob('*.html'))
    assert pages
    for file in pages:
        content=file.read_text()
        p=Page();p.feed(content)
        for url in p.links+p.assets:
            if url.startswith(('http:','https:','#','mailto:','tel:','data:','javascript:')):continue
            local=url.split('#',1)[0].split('?',1)[0]
            assert not local or (ROOT/local).exists(),f'{file}: broken link {url}'
        if file.name!='404.html':
            assert len(p.canonical)==1 and len(p.descriptions)==1,file
        else:assert 'adsbygoogle' not in content and 'noindex' in content
    home=Page();home.feed((ROOT/'index.html').read_text())
    assert home.cards==[f'{n:02}' for n in range(1,25)]
    assert not (ROOT/'data/today.json').exists()
    assert not (ROOT/'data/odds-recovery.json').exists()
    live=json.loads((ROOT/'data/home-live.json').read_text())
    assert all('meetDays' not in m and len(m.get('races',[]))==12 for m in live['meetings'])
    assert all('odds' not in r and 'result' not in r for m in live['meetings'] for r in m['races'])
    for meeting in live['meetings']:
        code=meeting['venueCode']
        assert (ROOT/f'data/venue/{code}.json').exists()
        assert (ROOT/f'data/venue-live/{code}.json').exists()
    js=(ROOT/'app.js').read_text()
    assert 'data/today.json' not in js and 'odds-recovery.json' not in js
    assert not re.search(r'setInterval\(loadRecent20Data',js)
    print(f'[release] {len(pages)} HTML pages, 24 static cards, '
          f'{len(live["meetings"])} active venues, links and split views OK')


if __name__=='__main__':main()
