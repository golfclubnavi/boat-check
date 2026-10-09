#!/usr/bin/env python3
"""Losslessly move inline CSS and the large application JS out of index.html.

Keeps the original order of stylesheet groups around scripts/linked CSS, so
the Work-era cascade and existing JS execute at the same document position.
"""
import re
from pathlib import Path

root=Path(__file__).resolve().parent.parent
page=root/'index.html'
html=page.read_text(encoding='utf-8')
if '<script src="app.js"></script>' in html:
    raise SystemExit('Assets have already been extracted')

script=re.compile(r'<script(?:\s[^>]*)?>[\s\S]*?</script>',re.I)
inline=[m for m in script.finditer(html) if not re.search(r'\bsrc=',m.group(0).split('>')[0],re.I)]
main=max(inline,key=lambda m:m.end()-m.start())
body=main.group(0).split('>',1)[1].rsplit('</script>',1)[0]
(root/'app.js').write_text(body,encoding='utf-8')
html=html[:main.start()]+'<script src="app.js"></script>'+html[main.end():]

tag=re.compile(r'<style(?:\s[^>]*)?>[\s\S]*?</style>|<script(?:\s[^>]*)?>[\s\S]*?</script>|<link\s[^>]*?>',re.I)
pieces=[];position=0;styles=[];first=None;count=0
def flush():
    global styles,first,count
    if not styles:return
    count+=1
    (root/f'app-style-{count}.css').write_text('\n'.join(styles),encoding='utf-8')
    pieces[first]=f'<link rel="stylesheet" href="app-style-{count}.css">'
    styles=[];first=None

for m in tag.finditer(html):
    pieces.append(html[position:m.start()]);value=m.group(0);position=m.end()
    if value.lower().startswith('<style'):
        if first is None:first=len(pieces)
        styles.append(value.split('>',1)[1].rsplit('</style>',1)[0]);pieces.append('')
    else:
        if value.lower().startswith('<script') or (value.lower().startswith('<link') and 'stylesheet' in value.lower()):flush()
        pieces.append(value)
pieces.append(html[position:]);flush()
page.write_text(''.join(pieces),encoding='utf-8')
print(f'Extracted {count} cascade-preserving CSS groups and app.js')
