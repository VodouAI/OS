#!/usr/bin/env bash
# Hermetic checks for the syndication raster: no network, no LLM, no deploy.
#
# What it protects: the figure dev.to receives is the ONLY copy of a diagram
# that cannot inherit a theme, because Forem strips every style attribute from
# an article body (verified against the live API). So it has to be light at the
# pixel level, and the check that says so has to fail on a dark one.
set -euo pipefail
cd "$(dirname "$0")/../../blog-site"
node_modules/.bin/esbuild test/diagram-png.test.ts --bundle --platform=node --format=esm \
  --external:sharp --outfile=test/.diagram-png.mjs --log-level=error
trap 'rm -f test/.diagram-png.mjs' EXIT
node test/.diagram-png.mjs
