#!/bin/sh
# =============================================================================
# Kairikos — scheduler loop, run inside the `scheduler` service defined in
# docker-compose.yml. Same "loop + sleep, trap TERM to exit cleanly" shape
# as the backup and certbot services.
#
# WHY THIS EXISTS: the portal's /api/cron/* routes have been live for a
# while, and vercel.json declares schedules for them — but this stack runs
# on Docker, where vercel.json is inert. Nothing was calling them. Every
# scheduled behaviour the portal believes it has was silently never
# running. This container is the missing caller.
#
# It deliberately knows NOTHING about what is due. It hits one endpoint on
# a fixed cadence and the application decides what work that tick implies
# — so scheduling logic lives in TypeScript where it is unit-tested,
# instead of in a crontab nobody can test and everybody forgets to update.
# That is also why the tick can be coarse: each job re-checks its own
# due-ness (the isDigestDue pattern), so a missed tick delays work rather
# than skipping it.
# =============================================================================

set -eu

BASE_URL="${SCHEDULER_TARGET_URL:-http://app:3000}"
INTERVAL_SECONDS="${SCHEDULER_INTERVAL_SECONDS:-300}"
# Long enough for a sweep that transcribes a backlog, short enough that a
# wedged request cannot stall the loop indefinitely.
TIMEOUT_SECONDS="${SCHEDULER_TIMEOUT_SECONDS:-120}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "[scheduler] CRON_SECRET is not set — refusing to start."
  echo "[scheduler] Without it every request would 401 and the loop would"
  echo "[scheduler] spin quietly forever, which looks exactly like working."
  exit 1
fi

trap 'echo "[scheduler] received TERM, exiting"; exit 0' TERM INT

echo "[scheduler] starting — target=${BASE_URL} interval=${INTERVAL_SECONDS}s"

# Endpoints to hit each tick. Add new ones here; each must be idempotent
# and safe to call more often than its work actually needs, because that
# is exactly what will happen.
ENDPOINTS="/api/cron/recall-tick /api/cron/prospecting-tick /api/cron/sync-seo-search-console /api/cron/generate-seo-content /api/cron/sync-seo-analytics"

while :; do
  for path in $ENDPOINTS; do
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    # -f so a non-2xx is a failure; -sS to stay quiet unless something
    # goes wrong. Never `set -e`-fatal: one bad tick must not kill the
    # loop and take every future tick with it.
    if body="$(curl -fsS --max-time "$TIMEOUT_SECONDS" \
        -H "Authorization: Bearer ${CRON_SECRET}" \
        "${BASE_URL}${path}" 2>&1)"; then
      echo "[scheduler] ${now} ${path} OK ${body}"
    else
      echo "[scheduler] ${now} ${path} FAILED: ${body}"
    fi
  done
  sleep "$INTERVAL_SECONDS" &
  wait $!
done
