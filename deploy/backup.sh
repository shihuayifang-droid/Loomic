#!/usr/bin/env bash
# HaHart backup (OP-08): PostgreSQL dump + object volume + compose/env config.
#
# SECURITY: config.tar.gz contains the production env file (secrets). The backup
# disk must be protected exactly like the production host.
#
# Environment:
#   HAHART_BACKUP_ROOT  daily backup root   (default /mnt/g/hahart-backup/daily)
#   HAHART_DEPLOY_DIR   deploy directory    (default /opt/hahart/current/deploy)
#   HAHART_ENV_FILE     production env file (default /opt/hahart/.env.production)
#   COMPOSE             compose command     (default "docker compose --env-file $HAHART_ENV_FILE")
#   HAHART_BACKUP_NOW   TEST ONLY: override "now" as YYYYmmdd-HHMMSS
#
# Exit code 0 on success; non-zero on any failure, with one reason line on stderr.
set -euo pipefail

ROOT="${HAHART_BACKUP_ROOT:-/mnt/g/hahart-backup/daily}"
DEPLOY_DIR="${HAHART_DEPLOY_DIR:-/opt/hahart/current/deploy}"
ENV_FILE="${HAHART_ENV_FILE:-/opt/hahart/.env.production}"
COMPOSE="${COMPOSE:-docker compose --env-file $ENV_FILE}"
WEEKLY_ROOT="$ROOT/../weekly"

STAMP="${HAHART_BACKUP_NOW:-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)}"
FINAL="$ROOT/$STAMP"
PARTIAL="$FINAL.partial"
STEP="init"

on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -rf "$PARTIAL"
    echo "backup failed at step '$STEP' (exit $rc)" >&2
  fi
}
trap on_exit EXIT

prune_keep() { # <dir> <keep-count>
  { ls -1 "$1" | grep -E '^[0-9]{8}-[0-9]{6}$' || true; } | sort | head -n "-$2" | while read -r name; do
    rm -rf "${1:?}/$name"
  done
}

STEP="prepare"
[ -f "$ENV_FILE" ] || { echo "env file not found" >&2; exit 2; }
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || { echo "docker-compose.yml not found in deploy dir" >&2; exit 2; }
mkdir -p "$ROOT"
rm -rf "$PARTIAL"
mkdir -p "$PARTIAL"
cd "$DEPLOY_DIR"

# COMPOSE is intentionally unquoted: it is a command line that must word-split.
STEP="pg_dump"
$COMPOSE exec -T postgres pg_dump -U hahart -d hahart -Fc > "$PARTIAL/db.dump"

STEP="objects"
$COMPOSE run --rm --no-deps -T -v hahart_objects:/v:ro --entrypoint tar server czf - -C /v . > "$PARTIAL/objects.tar.gz"

STEP="config"
STAGE="$PARTIAL/.stage"
mkdir -p "$STAGE"
cp "$DEPLOY_DIR/docker-compose.yml" "$STAGE/docker-compose.yml"
cp "$DEPLOY_DIR/nginx.conf" "$STAGE/nginx.conf"
cp "$ENV_FILE" "$STAGE/env.production"
chmod 600 "$STAGE/env.production"
printf '%s\n' "This archive contains the production env file (secrets)." \
  "Protect the backup disk exactly like the production host." > "$STAGE/README-SECRETS.txt"
tar czf "$PARTIAL/config.tar.gz" -C "$STAGE" .
rm -rf "$STAGE"

STEP="checksums"
(cd "$PARTIAL" && sha256sum db.dump objects.tar.gz config.tar.gz > SHA256SUMS)

STEP="manifest"
REV="unknown"
if [ -f "$DEPLOY_DIR/../REVISION" ]; then
  REV="$(head -n 1 "$DEPLOY_DIR/../REVISION" | tr -d '\r')"
  [ -n "$REV" ] || REV="unknown"
fi
{
  echo "time=$STAMP"
  echo "git_sha=$REV"
  for f in db.dump objects.tar.gz config.tar.gz; do
    echo "bytes.$f=$(wc -c < "$PARTIAL/$f" | tr -d ' ')"
  done
} > "$PARTIAL/MANIFEST"

STEP="finalize"
rm -rf "$FINAL"
mv "$PARTIAL" "$FINAL"

STEP="retention-daily"
prune_keep "$ROOT" 7

STEP="retention-weekly"
DAY="${STAMP%%-*}"
if [ "$(date -d "${DAY:0:4}-${DAY:4:2}-${DAY:6:2}" +%u)" = "7" ]; then
  mkdir -p "$WEEKLY_ROOT"
  rm -rf "${WEEKLY_ROOT:?}/$STAMP"
  cp -al "$FINAL" "$WEEKLY_ROOT/$STAMP" 2>/dev/null || cp -a "$FINAL" "$WEEKLY_ROOT/$STAMP"
  prune_keep "$WEEKLY_ROOT" 4
fi

STEP="done"
echo "backup ok: $FINAL"
