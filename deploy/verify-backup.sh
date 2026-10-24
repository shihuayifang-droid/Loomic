#!/usr/bin/env bash
# HaHart backup verification (OP-08): checksums + non-empty files + pg_restore --list.
# Usage: verify-backup.sh <backup-dir>
# Exit: 0 ok; 2 usage; 3 checksum mismatch; 4 missing/empty file; 5 dump unreadable.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: verify-backup.sh <backup-dir>" >&2; exit 2; }
DIR="$(cd "$1" && pwd)"
ENV_FILE="${HAHART_ENV_FILE:-/opt/hahart/.env.production}"
COMPOSE="${COMPOSE:-docker compose --env-file $ENV_FILE}"
DEPLOY_DIR="${HAHART_DEPLOY_DIR:-/opt/hahart/current/deploy}"

for f in SHA256SUMS db.dump objects.tar.gz config.tar.gz; do
  if [ ! -s "$DIR/$f" ]; then
    echo "missing or empty: $f" >&2
    exit 4
  fi
done

if ! (cd "$DIR" && sha256sum -c SHA256SUMS > /dev/null 2>&1); then
  echo "checksum mismatch" >&2
  exit 3
fi

[ -d "$DEPLOY_DIR" ] && cd "$DEPLOY_DIR"
# COMPOSE is intentionally unquoted: it is a command line that must word-split.
if ! $COMPOSE exec -T postgres pg_restore --list < "$DIR/db.dump" > /dev/null; then
  echo "pg_restore --list failed" >&2
  exit 5
fi

echo "verify ok: $DIR"
