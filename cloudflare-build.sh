#!/usr/bin/env bash
set -eu

rm -rf cloudflare-dist
mkdir -p cloudflare-dist/data

find . -maxdepth 1 -type f \( \
  -name '*.html' -o \
  -name '*.css' -o \
  -name '*.js' -o \
  -name 'robots.txt' -o \
  -name 'sitemap.xml' \
\) -exec cp '{}' cloudflare-dist/ \;

find data -maxdepth 1 -type f -name '*.json' ! -name 'today.json' \
  -exec cp '{}' cloudflare-dist/data/ \;
