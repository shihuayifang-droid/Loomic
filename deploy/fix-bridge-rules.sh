#!/usr/bin/env bash
#
# fix-bridge-rules.sh - re-add the docker "br-*" bridge iptables rules (idempotent, add-only).
#
# WHY THIS EXISTS (E-034, 2026-10-24, .37 cold boot):
#   After a cold boot of .37 the entire iptables rule set for the hahart_default
#   bridge was gone. The host runs with bridge-nf-call-iptables=1, so every packet
#   between containers (nginx -> server) is evaluated by iptables; with the bridge
#   rules missing it hit the FORWARD default policy (DROP) and every /api/* call
#   ended in 504 while the static pages still worked (nginx serves those itself).
#   docker.service reported "active" before the bridge rules existed again, so
#   "docker is up" is not a sufficient readiness check - hence a oneshot unit that
#   runs after docker.service and repairs the rules.
#
# WHAT IT DOES:
#   For every docker bridge (br-*) currently present on this host:
#     DOCKER-CT      -o <br> -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
#     DOCKER-FORWARD -i <br> -j ACCEPT
#     DOCKER-BRIDGE  -o <br> -j DOCKER
#   A rule is appended only when "iptables -C" reports it missing, so a second run
#   prints no "added:" lines at all.
#
# ADD-ONLY:
#   Other projects on the same box own their own br-* bridges; their rules are
#   never removed, flushed or rewritten here.
#
# RACE PROTECTION:
#   docker.service may be "active" while the bridges are not created yet, so when
#   no br-* bridge is found the script retries up to 10 times, 6 seconds apart
#   (60 s max) before giving up.
#
# Dependencies: bash, iproute2 (ip), iptables. No other tooling.

set -u

BRIDGE_WAIT_TRIES=10
BRIDGE_WAIT_SECONDS=6

log_err() {
  printf '%s\n' "$*" >&2
}

# One br-<id> name per line, sorted and de-duplicated.
list_bridges() {
  ip -o link show 2>/dev/null \
    | awk -F': ' '{print $2}' \
    | sed 's/@.*$//' \
    | grep '^br-' \
    | sort -u
}

have_rule() {
  local chain
  chain="$1"
  shift
  iptables -C "$chain" "$@" >/dev/null 2>&1
}

# add_rule <chain> <rule spec...>
# Appends the rule only when it is missing, prints "added: <chain> <rule>", and
# reports a failure on stderr with a non-zero return code.
add_rule() {
  local chain
  chain="$1"
  shift
  if have_rule "$chain" "$@"; then
    return 0
  fi
  if iptables -A "$chain" "$@"; then
    printf 'added: %s %s\n' "$chain" "$*"
    return 0
  fi
  log_err "failed: $chain $*"
  return 1
}

main() {
  if ! command -v iptables >/dev/null 2>&1; then
    log_err "iptables not found in PATH"
    exit 1
  fi

  local tries bridges bridge count failed
  tries=0
  bridges=""
  while : ; do
    bridges="$(list_bridges)"
    if [ -n "$bridges" ]; then
      break
    fi
    if [ "$tries" -ge "$BRIDGE_WAIT_TRIES" ]; then
      break
    fi
    tries=$((tries + 1))
    log_err "no br-* bridge yet, retry ${tries}/${BRIDGE_WAIT_TRIES} in ${BRIDGE_WAIT_SECONDS}s"
    sleep "$BRIDGE_WAIT_SECONDS"
  done

  count=0
  failed=0
  while IFS= read -r bridge; do
    if [ -z "$bridge" ]; then
      continue
    fi
    count=$((count + 1))
    add_rule DOCKER-CT -o "$bridge" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || failed=$((failed + 1))
    add_rule DOCKER-FORWARD -i "$bridge" -j ACCEPT || failed=$((failed + 1))
    add_rule DOCKER-BRIDGE -o "$bridge" -j DOCKER || failed=$((failed + 1))
  done <<EOF
$bridges
EOF

  printf 'checked %s docker bridge(s)\n' "$count"

  if [ "$failed" -ne 0 ]; then
    log_err "failed to add ${failed} rule(s)"
    exit 1
  fi
  exit 0
}

main "$@"
