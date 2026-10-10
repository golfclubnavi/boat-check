#!/usr/bin/env bash
set -eu

rm -rf cloudflare-dist
mkdir -p cloudflare-dist/data
cp -R assets cloudflare-dist/assets
cp _headers cloudflare-dist/_headers

find . -maxdepth 1 -type f \( \
  -name '*.html' -o \
  -name '*.css' -o \
  -name '*.js' -o \
  -name 'robots.txt' -o \
  -name 'sitemap.xml' -o \
  -name 'ads.txt' \
\) -exec cp '{}' cloudflare-dist/ \;

for name in yesterday tomorrow racers entry-details course-stats recent20; do
  test -s "data/$name.json"
  cp "data/$name.json" cloudflare-dist/data/
done

# Keep the canonical collector source in GitHub, not the public assets.
# Split dated home, venue and active-race LIVE views at every deployment.
python3 scripts/build_public_data.py --input data/today.json --outdir cloudflare-dist/data

# Provide readable, dated venue information before live JavaScript finishes.
node scripts/add_static_home.js cloudflare-dist
python3 scripts/release_check.py
