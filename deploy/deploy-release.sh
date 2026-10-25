#!/usr/bin/env bash
# HaHart release deploy -- runs on .37 inside WSL distro `hahart`.
#
# Usage:
#   ./deploy-release.sh <sha> <tar.gz>
#   e.g. ./deploy-release.sh 6af996a /mnt/c/Users/Admin/release-6af996a.tar.gz
#
# Prerequisites:
#   1. The release tarball is already uploaded to the host and reachable from WSL
#      (`git archive --format=tar.gz -o release-<sha>.tar.gz <sha>`, then scp).
#   2. /opt/hahart/.env.production already exists on the box (secrets live there,
#      never in this repo and never in this script).
#   3. Container images are built against the Tencent Cloud mirrors, because the
#      default registries are unusable from .37 (npmjs.org measured at ~30KiB/s,
#      npm/pip fetches die with EAI_AGAIN). See NPM_REGISTRY / PIP_INDEX_URL below;
#      both are overridable from the environment.
#
# The script waits for the docker daemon before touching it: after a cold boot the
# WSL boot hook and this script race, and building too early fails with
#   failed to connect to the docker API at unix:///var/run/docker.sock
# (the daemon needs ~55s to come up). The gate below waits up to 180s and prints
# `docker_ready` once the API answers.
#
# Steps are marked [N/7] in the log at /opt/hahart/deploy-<sha>.log.
set -uo pipefail

SHA="${1:?usage: deploy-rel.sh <sha> <tar>}"
TAR="${2:?usage: deploy-rel.sh <sha> <tar>}"
ENVF=/opt/hahart/.env.production
REL=/opt/hahart/releases/$SHA
LOG=/opt/hahart/deploy-$SHA.log
# Tencent Cloud mirrors: the public npm/pip registries are too slow / flaky from .37,
# so every build pulls packages through the mirrors unless the caller overrides them.
export NPM_REGISTRY="${NPM_REGISTRY:-https://mirrors.cloud.tencent.com/npm/}"
export NPM_NETWORK_CONCURRENCY="${NPM_NETWORK_CONCURRENCY:-6}"
export NPM_FETCH_RETRIES="${NPM_FETCH_RETRIES:-6}"
export NPM_FETCH_TIMEOUT="${NPM_FETCH_TIMEOUT:-120000}"
export PIP_INDEX_URL="${PIP_INDEX_URL:-https://mirrors.cloud.tencent.com/pypi/simple}"
export PIP_TIMEOUT="${PIP_TIMEOUT:-120}"
export PIP_RETRIES="${PIP_RETRIES:-5}"

mkdir -p /opt/hahart/releases
exec > >(tee -a "$LOG") 2>&1

echo "deploy start sha=$SHA tar=$TAR log=$LOG"

[ -f "$TAR" ] || { echo "DEPLOY_FAILED: release tarball not found: $TAR"; exit 1; }
[ -f "$ENVF" ] || { echo "DEPLOY_FAILED: env file not found: $ENVF"; exit 1; }

# Wait for the docker daemon first: the boot hook may still be starting it.
for _ in $(seq 1 180); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo "DEPLOY_FAILED: docker daemon never came up"; exit 1; }
echo "docker_ready"

COMPOSE="docker compose --env-file $ENVF"

# 1/7 -- unpack the release into its own directory.
echo "[1/7] extract $TAR -> $REL"
rm -rf "$REL"
mkdir -p "$REL"
tar xzf "$TAR" -C "$REL" || { echo "DEPLOY_FAILED at extract"; exit 1; }

# 2/7 -- put the production env file where compose expects it (deploy/.env.production).
echo "[2/7] env $ENVF -> $REL/deploy/.env.production"
install -m 0600 "$ENVF" "$REL/deploy/.env.production" || { echo "DEPLOY_FAILED at env"; exit 1; }

# 3/7 -- refresh the ops scripts/units from the release (they are versioned now).
echo "[3/7] ops scripts"
install_opt() { # <src-relative-to-deploy> <mode> <dest>
  if [ -f "$REL/deploy/$1" ]; then
    install -m "$2" "$REL/deploy/$1" "$3" && echo "ops: $3"
  else
    echo "ops: skip (not in release) $1"
  fi
}
install_opt backup.sh 0755 /opt/hahart/backup.sh
install_opt verify-backup.sh 0755 /opt/hahart/verify-backup.sh
install_opt restore.sh 0755 /opt/hahart/restore.sh
install_opt backup-and-verify.sh 0755 /opt/hahart/backup-and-verify.sh
install_opt fix-bridge-rules.sh 0755 /opt/hahart/fix-bridge-rules.sh
install_opt hahart-bridge-rules.service 0644 /etc/systemd/system/hahart-bridge-rules.service
install_opt hahart-backup.service 0644 /etc/systemd/system/hahart-backup.service
install_opt hahart-backup.timer 0644 /etc/systemd/system/hahart-backup.timer
systemctl daemon-reload || { echo "DEPLOY_FAILED at ops scripts (daemon-reload)"; exit 1; }

# 4/7 -- switch the `current` symlink and record the revision (backup.sh reads it).
echo "[4/7] switch current -> $REL"
ln -sfn "$REL" /opt/hahart/current || { echo "DEPLOY_FAILED at switch current"; exit 1; }
printf '%s\n' "$SHA" > /opt/hahart/current/REVISION || { echo "DEPLOY_FAILED at switch current (REVISION)"; exit 1; }

# 5/7 -- compose file sanity before building anything.
echo "[5/7] compose config"
cd "$REL/deploy" || { echo "DEPLOY_FAILED at compose config (cd)"; exit 1; }
$COMPOSE config -q || { echo "DEPLOY_FAILED at compose config"; exit 1; }
echo "COMPOSE_CONFIG_OK"

# 6/7 -- build the three images.
echo "[6/7] build"
$COMPOSE build
BUILD_RC=$?
echo "BUILD_RC=$BUILD_RC"
[ "$BUILD_RC" -eq 0 ] || { echo "DEPLOY_FAILED at build"; exit 1; }

# 7/7 -- bring the stack up and wait until every container is running (and, where a
#        healthcheck exists, healthy).
echo "[7/7] up + wait healthy"
$COMPOSE up -d --remove-orphans || { echo "DEPLOY_FAILED at up"; exit 1; }

wait_healthy() { # <service>
  local svc="$1" cid status health i
  for i in $(seq 1 300); do
    cid="$($COMPOSE ps -q "$svc" 2>/dev/null | head -n 1)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
      if [ "$status" = "running" ]; then
        health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null)"
        case "$health" in
          healthy | none)
            echo "healthy: $svc ($health)"
            return 0
            ;;
          unhealthy)
            echo "DEPLOY_FAILED: $svc is unhealthy"
            return 1
            ;;
        esac
      fi
    fi
    sleep 2
  done
  echo "DEPLOY_FAILED: $svc did not become healthy in time"
  return 1
}

for svc in postgres server worker web; do
  wait_healthy "$svc" || exit 1
done

echo "DEPLOY_DONE sha=$SHA"
