#!/usr/bin/env bash
#
# verify-delivery.sh — prove a scheduled result can actually REACH the user.
#
# The defect this guards (F2 / D15). On 2026-08-19 `morning-briefing` produced
# 4,942 chars, reported success, and the user received nothing: Telegram rejects
# anything over 4,096 with HTTP 400 "message is too long". Every other outbound
# path had the opposite bug — `substring(0, 4000)` truncated and called it
# delivered (2,221 stored replies exceed that length). Both failures are
# invisible from the run's own point of view, which is why this checks the
# CHUNKER'S OUTPUT rather than the send's return code.
#
# Two layers, because they fail differently:
#   OFFLINE (default) — the chunking invariants, hermetic, no network, no sends.
#     Nothing over the channel cap; nothing dropped; no chunk left holding an
#     unclosed code fence.
#   LIVE (--live)     — actually fires a skill at a real channel and asserts the
#     run row says delivery_ok=1. Sends a real message, so it is OPT-IN and
#     never runs in CI.
#
# Usage:
#   bash scripts/verify-delivery.sh            # offline invariants only
#   bash scripts/verify-delivery.sh --live     # also fires morning-briefing

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GW="MCP-servers/Vodou-Console"

pass=0; fail=0; skip=0
ok()   { printf "  ok   %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "NOT OK %s\n" "$1"; fail=$((fail+1)); }
# A skipped check is NOT a passing one. Counted and reported in the summary
# because a verifier that quietly skips its real work and exits 0 is CI theatre —
# the build goes green and nobody learns that nothing was proved.
skip() { printf "  ..   SKIPPED %s\n" "$1"; skip=$((skip+1)); }

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

echo "── 1. chunking invariants (offline) ──"
if [ ! -f "$GW/dist/channel-chunk.js" ]; then
  bad "dist/channel-chunk.js missing — run npm run build in $GW"
else
  node --input-type=module -e "
    import { chunkTextForOutbound, outboundLimitFor } from './$GW/dist/channel-chunk.js';
    let bad = 0;
    const fail = (m) => { console.log('NOT OK ' + m); bad++; };
    const ok   = (m) => console.log('  ok   ' + m);

    // The exact failing shape: a briefing well past Telegram's 4,096 cap.
    const para = 'The overnight run surfaced items worth your attention today. ';
    // 9,000 chars, per F2's spec: enough to require at least three messages at
    // Telegram's cap, so the test exercises a real multi-chunk send rather than
    // the trivial two-chunk case.
    let briefing = '';
    for (let i = 1; briefing.length < 9000; i++) briefing += i + '. ' + para + '\n\n';
    briefing = briefing.trimEnd();
    const lim = outboundLimitFor('telegram');
    const parts = chunkTextForOutbound(briefing, lim);
    if (briefing.length < 9000) fail('fixture is only ' + briefing.length + ' chars — needs >=9000 to force 3+ messages');
    else ok('fixture is ' + briefing.length + ' chars (Telegram cap is 4096)');
    if (parts.length < 3) fail('expected >=3 messages, got ' + parts.length);
    else ok(parts.length + ' messages, none over ' + lim);
    for (const p of parts) if (p.length > lim) fail('a chunk is ' + p.length + ' chars (> ' + lim + ')');

    // Nothing dropped. This is the half that substring(0, 4000) got wrong, and
    // it is the half a send's return code can never tell you about.
    const norm = (t) => t.replace(/\`\`\`[^\n\`]*/g, ' ').replace(/\s+/g, ' ').trim();
    if (norm(parts.join('\n')) !== norm(briefing)) fail('content was dropped or reordered');
    else ok('every character survives the split');

    // No chunk may end holding an unclosed fence, or the rest of the message
    // renders as unstyled soup in every client downstream.
    const code = Array.from({length: 220}, (_, i) => 'const x' + i + ' = ' + i + ';').join('\n');
    const fenced = 'Report:\n\n\`\`\`ts\n' + code + '\n\`\`\`\n\nTrailing prose.';
    const fp = chunkTextForOutbound(fenced, 800);
    const openEnded = fp.filter(p => ((p.match(/\`\`\`/g) || []).length % 2) === 1);
    if (openEnded.length) fail(openEnded.length + ' chunk(s) end inside a code fence');
    else ok('code fences close and reopen across ' + fp.length + ' chunks');
    for (const p of fp) if (p.length > 800) fail('fenced chunk is ' + p.length + ' chars (> 800)');

    process.exit(bad ? 1 : 0);
  " && ok "offline invariants hold" || bad "offline invariants FAILED"
fi

echo
echo "── 2. no outbound path truncates ──"
# The chunker is only a fix if every send actually routes through it. A single
# surviving substring() is the whole bug back, silently.
if grep -nE "substring\(0, *4000\)" "$GW/src/index.ts" | grep -vE "^\s*[0-9]+: *(\*|//)" | grep -q .; then
  bad "a substring(0, 4000) survives in a code path:"
  grep -nE "substring\(0, *4000\)" "$GW/src/index.ts" | grep -vE ": *(\*|//)"
else
  ok "no truncating send paths remain (comments referencing it are fine)"
fi

echo
echo "── 3. the funnel milestone has a producer ──"
# first_automation is the alpha gate. It was declared and never marked, so it
# read "not reached" forever — indistinguishable from a product that never works.
if grep -rq "markFunnel('first_automation')" "$GW/src" --include="*.ts"; then
  ok "markFunnel('first_automation') has a call site"
else
  bad "first_automation is declared but nothing marks it — the gate cannot fire"
fi

if [ "$LIVE" = "1" ]; then
  echo
  echo "── 4. LIVE fire (sends a real message) ──"
  SECRET="$(grep -E '^VODOU_GATEWAY_SCHEDULER_SECRET=' .env 2>/dev/null | cut -d= -f2-)"
  CONV="workbench:skill-console:morning-briefing"
  SKILL_ID="$(sqlite3 "$GW/gateway.db" "SELECT id FROM skills_meta WHERE name='morning-briefing';")"
  if [ -z "$SKILL_ID" ]; then
    bad "no skills_meta row named morning-briefing"
  else
    before="$(sqlite3 vodou-core.db 'SELECT COALESCE(MAX(id),0) FROM scheduled_task_runs;')"
    resp="$(curl -s -m 900 -X POST http://127.0.0.1:8765/chat/skill-fire \
      -H 'Content-Type: application/json' \
      ${SECRET:+-H "x-scheduler-secret: $SECRET"} \
      -d "{\"skillId\":$SKILL_ID,\"conversationId\":\"$CONV\"}")"
    delivered="$(printf '%s' "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("delivered"))' 2>/dev/null)"
    if [ "$delivered" = "True" ]; then ok "res.delivered === true"; else bad "res.delivered = $delivered"; fi
    row="$(sqlite3 vodou-core.db "SELECT status||' chars='||COALESCE(output_chars,0)||' delivery_ok='||COALESCE(delivery_ok,'null') FROM scheduled_task_runs WHERE id>$before ORDER BY id DESC LIMIT 1;")"
    [ -n "$row" ] && ok "run row: $row" || bad "no new scheduled_task_runs row"
  fi
  f="$(sqlite3 "$GW/gateway.db" "SELECT value FROM gateway_settings WHERE key='funnel.first_automation';")"
  [ -n "$f" ] && ok "funnel.first_automation = $f" || bad "funnel.first_automation still not set"
fi

echo
# A verifier that degrades to almost no checks and exits 0 is worse than no
# verifier: the build goes green and the absence of coverage is invisible. CI
# sets a floor so "everything skipped" fails loudly instead.
if [ -n "${VODOU_VERIFY_MIN_CHECKS:-}" ] && [ "$pass" -lt "$VODOU_VERIFY_MIN_CHECKS" ]; then
  echo "NOT OK only $pass check(s) ran; VODOU_VERIFY_MIN_CHECKS=$VODOU_VERIFY_MIN_CHECKS required"
  echo "       (${skip} skipped — a missing prerequisite usually means the CI image lacks a tool)"
  fail=$((fail+1))
fi

if [ "$fail" -eq 0 ]; then echo "✅ delivery chain intact ($pass checks)"; exit 0; fi
echo "❌ delivery chain BROKEN ($fail failed, $pass passed)"; exit 1
