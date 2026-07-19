#!/bin/sh
# check-channel-sync.sh — fail loudly when the DEV adapter copies (src/channels/*.ts)
# are newer than the LIVE built copies (packages/<ch>/dist/<ch>.js).
#
# Why this exists: the adapters live in two places. src/channels/ is where fixes
# get written; packages/<ch>/ is what the channel-loader actually loads at runtime
# (via ~/.vodou/channels symlinks). On 2026-07-11 a QA sweep found the live copies
# were ~8 weeks behind — the CWE-639 telegram/discord/googlechat impersonation fix,
# the Slack self-echo guard, and the web port-shadow fix had never shipped.
# (PLANS/0.6.15/PLAN-QA-SWEEP-FINDINGS.md, P0-1.)
#
# Sync recipe when this fires: copy the newer src/channels/<ch>.ts body into
# packages/<ch>/src/<ch>.ts, rewrite imports ('../types.js', '../channel-allowlist.js',
# '../channel-attachment-download.js' -> '@vodou/channel-sdk'; '../db.js' ->
# 'node:sqlite'), keep the manifest() method INSIDE the class (googlechat has code
# after the class!), then `npm run build` in that package. Verify the fix marker
# strings land in packages/<ch>/dist/<ch>.js before restarting bridges.
#
# Exit 0 = in sync. Exit 1 = drift (stale adapters listed on stdout).

cd "$(dirname "$0")/.." || exit 2

stale=""
for src in src/channels/*.ts; do
  ch=$(basename "$src" .ts)
  # teams-outbound-rest is a helper module inside packages/teams, not its own package
  case "$ch" in teams-outbound-rest) dist="packages/teams/dist/teams-outbound-rest.js" ;; *) dist="packages/$ch/dist/$ch.js" ;; esac
  [ -f "$dist" ] || { stale="$stale $ch(no-dist)"; continue; }
  if [ "$src" -nt "$dist" ]; then
    stale="$stale $ch"
  fi
done

if [ -n "$stale" ]; then
  echo "⚠️  CHANNEL DRIFT:$stale — src/channels/ is newer than the LIVE packages/*/dist build."
  echo "   Runtime loads packages/*/dist via ~/.vodou/channels symlinks; your fix has NOT shipped."
  echo "   See sync recipe in $(pwd)/scripts/check-channel-sync.sh"
  exit 1
fi
exit 0
