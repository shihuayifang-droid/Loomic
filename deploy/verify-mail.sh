#!/usr/bin/env bash
# HaHart U-28 acceptance (workorder 45CM): prove the configured mail gateway
# really delivers, by sending one message from inside the running server
# container and passing the CLI's exit code through unchanged.
#
# Usage: ./verify-mail.sh <to-address>
# Exit: 0 sent (a human still has to open the inbox); 1 container or CLI failure;
#       2 usage, or HAHART_MAIL_API_URL / HAHART_MAIL_API_TOKEN missing in the
#       container (nothing has been configured yet -- that is U-28, not a bug).
#
# The token and the gateway URL are never printed: only the CLI's `url_host=`.
set -euo pipefail

CONTAINER="${HAHART_SERVER_CONTAINER:-hahart-server-1}"
TEMPLATE="reset-password"

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: verify-mail.sh <to-address>" >&2
  exit 2
fi

TO="$1"

case "$TO" in
  *@*.*) ;;
  *)
    echo "not an email address: $TO" >&2
    exit 2
    ;;
esac

# 1. the container has to be running, otherwise `docker exec` fails for a reason
#    that has nothing to do with mail configuration.
RUNNING="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$RUNNING" != "true" ]; then
  echo "container not running: $CONTAINER" >&2
  echo "  check: docker compose --env-file /opt/hahart/.env.production -f <release>/deploy/docker-compose.yml ps" >&2
  exit 1
fi

# 2. the container is where the credentials must be; the host shell may not have
#    them and `docker exec` does not inherit them from here.
#    Each value is only tested for emptiness -- it is never echoed.
mail_env_ok() {
  docker exec "$CONTAINER" sh -c 'test -n "${HAHART_MAIL_API_URL:-}" && test -n "${HAHART_MAIL_API_TOKEN:-}"' >/dev/null 2>&1
}

if ! mail_env_ok; then
  echo "mail not configured in $CONTAINER: HAHART_MAIL_API_URL / HAHART_MAIL_API_TOKEN missing or empty" >&2
  echo "  set both in /opt/hahart/.env.production (U-28) and restart the server, then rerun" >&2
  exit 2
fi

# 3. send. Exit codes from hahart-mail-send.ts: 0 sent, 1 send failed,
#    2 usage, 3 mailer=noop. All of them are passed through as-is so that the
#    caller can tell "not configured" (3) from "configured but broken" (1).
RC=0
docker exec "$CONTAINER" node --import tsx ./src/cli/hahart-mail-send.ts \
  --to "$TO" --template "$TEMPLATE" || RC=$?

if [ "$RC" -ne 0 ]; then
  echo "mail send failed (exit $RC)" >&2
  if [ "$RC" -eq 3 ]; then
    echo "  exit 3 = mailer=noop: the credentials are not visible to the CLI process" >&2
  fi
  exit "$RC"
fi

echo "verify-mail ok: sent to $TO (template=$TEMPLATE)"
echo "MANUAL STEP: open the inbox of $TO and confirm"
echo "  - sender name / subject / body show the HaHart brand and Chinese copy"
echo "  - no \"Loomic\" wording anywhere in the message"
echo "  - the reset button and the fallback link render (the link itself is an inert placeholder)"
