#!/usr/bin/env python3
"""Mechanically externalize existing images without changing their bytes."""
import base64
import hashlib
import re
from pathlib import Path

pattern=re.compile(r'data:image/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)')
root=Path(__file__).resolve().parent.parent
assets=root/'assets/icons';assets.mkdir(parents=True,exist_ok=True)
count=0
def replace(match):
    global count
    blob=base64.b64decode(match[2],validate=True)
    ext={'jpeg':'jpg','svg+xml':'svg'}.get(match[1],match[1])
    name=f'{hashlib.sha256(blob).hexdigest()[:20]}.{ext}'
    (assets/name).write_bytes(blob);count+=1
    return f'assets/icons/{name}'
for file in root.iterdir():
    if file.suffix not in ('.html','.js','.css'):continue
    source=file.read_text();updated=pattern.sub(replace,source)
    if source!=updated:file.write_text(updated)
print(f'[assets] {count} references, {len(list(assets.iterdir()))} distinct original images')
