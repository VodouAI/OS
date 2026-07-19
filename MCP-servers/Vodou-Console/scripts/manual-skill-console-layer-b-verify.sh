#!/usr/bin/env bash
# PLAN-SKILL-CONSOLE-LOOP — release-style smoke + Layer B manual checklist.
# Default: GET /health only. Optional: POST /chat (needs a configured LLM on the gateway).
set -euo pipefail

PORT="${WEB_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"

usage() {
  cat <<'USAGE'
Usage: manual-skill-console-layer-b-verify.sh [options]

  (no args)       Require /health 200, then print the human checklist.
  --curl-chat     After health, POST a minimal /chat (needs LLM configured).
                  Default curl wall-clock is 300s (override: CHAT_CURL_MAX_TIME).
                  Why so long: first message is NOT \"conversational-only\", so chat()
                  runs BrainLoader (worker or CLI, up to ~60s) then the provider LLM.
                  A 120s curl budget often loses to 60s brain + slow Anthropic/OpenAI.

Environment: WEB_PORT (default 8765), CHAT_CURL_MAX_TIME (default 300).
Automated coverage: npm test (includes tests/chat-post-http.test.ts with mocked chat()).
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! curl -sf "${BASE}/health" >/dev/null; then
  echo "Gateway not reachable at ${BASE}/health — start the gateway (e.g. node dist/index.js or start-vodou-services.sh)." >&2
  exit 1
fi
echo "Gateway health OK at ${BASE}/health"

if [[ "${1:-}" == "--curl-chat" ]]; then
  tmp="$(mktemp)"
  MAX="${CHAT_CURL_MAX_TIME:-300}"
  set +e
  code="$(curl -s --max-time "${MAX}" -o "${tmp}" -w "%{http_code}" -X POST "${BASE}/chat" \
    -H "Content-Type: application/json" \
    -d '{"message":"[skill-console release verify] ping"}')"
  curl_ec=$?
  set -e
  echo "POST /chat → HTTP ${code:-?} (curl exit ${curl_ec}, max-time ${MAX}s)"
  head -c 400 "${tmp}" || true
  echo
  rm -f "${tmp}"
  if [[ "${curl_ec}" == "28" ]]; then
    echo "Timed out: BrainLoader can use up to ~60s; add slow LLM/network. Try CHAT_CURL_MAX_TIME=600, start ./vodou-core worker, or POST a conversational ping like {\"message\":\"hi\"} to skip BrainLoader." >&2
  fi
  if [[ "${code}" != "200" && "${curl_ec}" != "28" ]]; then
    echo "(Non-200 is expected if ANTHROPIC_API_KEY / Claude CLI is not configured.)" >&2
  fi
fi

cat <<'EOF'

Manual checklist (Layer B + skill console):
1. Create a skill with vc_skills_create; optional stopping_points (same schema as unified AGENT_ACTIONS).
2. Open the skill tab. Send a normal message: expect a guided-step menu or a short intro line + menu (streaming).
3. Send a non-number reply: expect a clear retry message and the menu again (not generic unrelated chat).
4. Try /menu, /phase, /phase reset, /phase skip — behavior matches /help.
5. If you use cron + skill_run: confirm scheduled fire still hits POST /chat/skill-fire and respects Layer B seeding.

EOF
