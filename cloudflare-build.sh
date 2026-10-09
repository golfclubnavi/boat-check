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

find data -maxdepth 1 -type f -name '*.json' ! -name 'today.json' ! -name 'odds-recovery.json' \
  ! -name 'home-live.json' ! -name 'settlements.json' \
  -exec cp '{}' cloudflare-dist/data/ \;

# Keep the 37 MB collector source in GitHub, not the public assets.
# Split dated home, venue and active-race LIVE views at every deployment.
python3 scripts/build_public_data.py --input data/today.json --outdir cloudflare-dist/data

# Provide readable, dated venue information before live JavaScript finishes.
node scripts/add_static_home.js cloudflare-dist
