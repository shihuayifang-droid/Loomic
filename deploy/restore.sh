#!/usr/bin/env bash
# HaHart restore (OP-08). Usage: restore.sh <backup-dir> --yes
# Verifies SHA256SUMS first (mismatch -> exit 3). Without --yes nothing is restored (exit 2).
# The config archive is NOT applied automatically; its location is printed instead.
set -euo pipefail

DIR=""
YES=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    *) DIR="$a" ;;
  esac
done
[ -n "$DIR" ] || { echo "usage: restore.sh <backup-dir> --yes" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
ENV_FILE="${HAHART_ENV_FILE:-/opt/hahart/.env.production}"
COMPOSE="${COMPOSE:-docker compose --env-file $ENV_FILE}"
DEPLOY_DIR="${HAHART_DEPLOY_DIR:-/opt/hahart/current/deploy}"

if ! (cd "$DIR" && sha256sum -c SHA256SUMS > /dev/null 2>&1); then
  echo "checksum mismatch: refusing to restore" >&2
  exit 3
fi

if [ "$YES" -ne 1 ]; then
  echo "checksums ok; re-run with --yes to restore (this overwrites database and objects)" >&2
  exit 2
fi

[ -d "$DEPLOY_DIR" ] && cd "$DEPLOY_DIR"
# COMPOSE is intentionally unquoted: it is a command line that must word-split.
$COMPOSE exec -T postgres pg_restore --clean --if-exists -U hahart -d hahart < "$DIR/db.dump"
$COMPOSE run --rm --no-deps -T -v hahart_objects:/v --entrypoint tar server xzf - -C /v < "$DIR/objects.tar.gz"

echo "database and objects restored from: $DIR"
echo "config NOT applied. Inspect $DIR/config.tar.gz and copy files by hand (env.production holds secrets)."
