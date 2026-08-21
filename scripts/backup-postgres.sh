#!/bin/sh
# =============================================================================
# Kairikos — Postgres backup loop, run inside the `backup` service defined
# in docker-compose.yml. Dumps the portal's Postgres to a timestamped,
# gzipped file, prunes dumps older than BACKUP_RETENTION_DAYS, sleeps,
# repeats. Same "loop + sleep, trap TERM to exit cleanly" shape as the
# certbot service in docker-compose.yml.
#
# A backup nobody has restored is not a backup — see
# scripts/restore-postgres.sh for the paired restore procedure, and
# actually run it once against a throwaway database after the first
# deploy to confirm the dumps are real.
# =============================================================================

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

trap 'echo "[backup] received TERM, exiting"; exit 0' TERM INT

echo "[backup] starting — dir=$BACKUP_DIR retention=${RETENTION_DAYS}d interval=${INTERVAL_SECONDS}s"

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/kairikos-portal-${stamp}.sql.gz"
  tmp="${out}.tmp"

  echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) dumping ${POSTGRES_DB} -> ${out}"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain | gzip > "$tmp"; then
    mv "$tmp" "$out"
    echo "[backup] OK: $(du -h "$out" | cut -f1)"
  else
    echo "[backup] FAILED — leaving no partial file"
    rm -f "$tmp"
  fi

  # Prune dumps older than RETENTION_DAYS. -mtime +N means "more than N
  # whole days old", so RETENTION_DAYS=14 keeps roughly the last 14 daily
  # dumps.
  find "$BACKUP_DIR" -maxdepth 1 -name 'kairikos-portal-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete | sed 's/^/[backup] pruned: /'

  sleep "$INTERVAL_SECONDS" &
  wait $!
done
