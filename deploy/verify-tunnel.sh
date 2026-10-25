#!/usr/bin/env bash
# HaHart U-29 acceptance (workorder 45CM): is the Cloudflare Tunnel actually
# serving the deployment on the public hostname?
#
# Usage: ./verify-tunnel.sh <public-hostname>        e.g. app.example.com
#        (hostname only -- scheme and trailing slash are stripped, nothing is
#        hard-coded, because the U-29 domain was still open when this was written)
#
# Exit: 0 all four checks passed; 1 a check failed (the failing step is named);
#       2 usage, or CLOUDFLARE_TUNNEL_TOKEN is empty.
#
# The token itself is never printed, and neither is the env file's contents:
# only whether the variable is set.
set -euo pipefail

ENV_FILE="${HAHART_ENV_FILE:-/opt/hahart/.env.production}"
COMPOSE_FILE="${HAHART_COMPOSE_FILE:-/opt/hahart/current/deploy/docker-compose.yml}"
HOST_RAW="${1:-}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if [ $# -ne 1 ] || [ -z "$HOST_RAW" ]; then
  echo "usage: verify-tunnel.sh <public-hostname>   e.g. app.example.com" >&2
  exit 2
fi

# Tolerate a pasted URL: strip scheme and any trailing slash/path.
HOST="${HOST_RAW#http://}"
HOST="${HOST#https://}"
HOST="${HOST%%/*}"

if [ -z "$HOST" ]; then
  echo "not a hostname: $HOST_RAW" >&2
  exit 2
fi

[ -f "$COMPOSE_FILE" ] || fail "step 0: compose file not found: $COMPOSE_FILE (set HAHART_COMPOSE_FILE)"
[ -f "$ENV_FILE" ] || fail "step 0: env file not found: $ENV_FILE (set HAHART_ENV_FILE)"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile tunnel)

# --- step 1: the tunnel token must be set -------------------------------------
# Environment first, then the compose env file. Value is never echoed.
TOKEN_SET=0
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  TOKEN_SET=1
elif grep -Eq '^[[:space:]]*CLOUDFLARE_TUNNEL_TOKEN=.+' "$ENV_FILE"; then
  TOKEN_SET=1
fi

if [ "$TOKEN_SET" -ne 1 ]; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is empty (environment and $ENV_FILE)" >&2
  echo "  U-29: create the tunnel, put the token in the env file, then rerun" >&2
  exit 2
fi

echo "step 1/4 ok: CLOUDFLARE_TUNNEL_TOKEN is set"

# --- step 2: the cloudflared container is up ---------------------------------
PS_OUT="$("${COMPOSE[@]}" ps cloudflared 2>&1)" || fail "step 2: docker compose ps failed
$PS_OUT"

case "$PS_OUT" in
  *Up*) ;;
  *)
    fail "step 2: cloudflared is not Up
$PS_OUT
  check: ${COMPOSE[*]} up -d"
    ;;
esac

echo "step 2/4 ok: cloudflared is Up"

curl_ok() {
  # -f so a 4xx/5xx is a failure, explicit timeouts so this never hangs.
  curl -fsS --connect-timeout 5 --max-time 15 "$@"
}

# --- step 3: the public hostname answers 200 ---------------------------------
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
  "https://$HOST/" 2>/dev/null || true)"

if [ "$CODE" != "200" ]; then
  fail "step 3: GET https://$HOST/ returned ${CODE:-<no response>} (expected 200)
  check: tunnel DNS/route for $HOST, and web container health"
fi

echo "step 3/4 ok: GET https://$HOST/ -> 200"

# --- step 4: /api/health answers 200 with {"ok":true} ------------------------
HEALTH_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 \
  "https://$HOST/api/health" 2>/dev/null || true)"

if [ "$HEALTH_CODE" != "200" ]; then
  fail "step 4: GET https://$HOST/api/health returned ${HEALTH_CODE:-<no response>} (expected 200)"
fi

HEALTH_BODY="$(curl_ok "https://$HOST/api/health" 2>/dev/null || true)"

if ! printf '%s' "$HEALTH_BODY" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
  fail "step 4: /api/health body has no \"ok\":true
  body: $HEALTH_BODY"
fi

echo "step 4/4 ok: GET https://$HOST/api/health -> 200 with \"ok\":true"
echo "verify-tunnel ok: https://$HOST is served by the tunnel"
