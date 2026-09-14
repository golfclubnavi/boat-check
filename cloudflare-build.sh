#!/usr/bin/env bash
set -eu

rm -rf cloudflare-dist
mkdir -p cloudflare-dist/data

find . -maxdepth 1 -type f \( \
  -name '*.html' -o \
  -name '*.css' -o \
  -name '*.js' -o \
  -name 'robots.txt' -o \
  -name 'sitemap.xml' -o \
  -name 'ads.txt' \
\) -exec cp '{}' cloudflare-dist/ \;

find data -maxdepth 1 -type f -name '*.json' ! -name 'today.json' \
  -exec cp '{}' cloudflare-dist/data/ \;

# The source JSON is human-readable and roughly three times larger than needed.
# Minifying it at build time keeps the same data while making the initial page
# load much faster from Cloudflare's own CDN.
if [ -f data/today.json ]; then
  node -e 'const fs=require("fs");const src=process.argv[1];const dest=process.argv[2];fs.writeFileSync(dest,JSON.stringify(JSON.parse(fs.readFileSync(src,"utf8"))))' \
    data/today.json cloudflare-dist/data/today.json
fi
