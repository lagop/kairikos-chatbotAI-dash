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
#
# COPIA EXTERNA (29/09/2026). Hasta hoy los volcados solo vivían en un
# volumen de la MISMA VPS que la base de datos: si se perdía la máquina, se
# perdían las dos cosas a la vez. Ahora cada volcado, además de guardarse
# aquí, se cifra y se sube fuera:
#
#   - Se cifra con age y una clave PÚBLICA (BACKUP_AGE_RECIPIENT). La
#     privada no está en la VPS ni en ningún secreto del despliegue: la
#     guarda el titular fuera de línea. Así ni quien entre en la VPS ni el
#     proveedor de almacenamiento pueden leer las copias.
#   - Se sube con rclone a un almacenamiento compatible con S3 en la UE
#     (BACKUP_OFFSITE_*). La clave de acceso conviene que pueda ESCRIBIR y
#     no borrar: la retención del lado remoto la pone una regla de ciclo de
#     vida del propio bucket. Así un atacante con la VPS no puede borrar
#     también las copias externas.
#
# Si falta alguna variable, la copia externa se salta y lo dice en el log;
# la local sigue igual. Si la subida falla, también. Una copia externa que
# falla nunca rompe la local.
# =============================================================================

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

trap 'echo "[backup] received TERM, exiting"; exit 0' TERM INT

# rclone se configura por variables de entorno: un remoto llamado «externo»
# de tipo S3. Sin archivo de configuración que se quede desfasado.
export RCLONE_CONFIG_EXTERNO_TYPE=s3
export RCLONE_CONFIG_EXTERNO_PROVIDER="${BACKUP_OFFSITE_PROVIDER:-Other}"
export RCLONE_CONFIG_EXTERNO_ENDPOINT="${BACKUP_OFFSITE_ENDPOINT:-}"
export RCLONE_CONFIG_EXTERNO_REGION="${BACKUP_OFFSITE_REGION:-}"
export RCLONE_CONFIG_EXTERNO_ACCESS_KEY_ID="${BACKUP_OFFSITE_ACCESS_KEY_ID:-}"
export RCLONE_CONFIG_EXTERNO_SECRET_ACCESS_KEY="${BACKUP_OFFSITE_SECRET_ACCESS_KEY:-}"
# La clave puede no tener permiso para crear ni comprobar buckets.
export RCLONE_CONFIG_EXTERNO_NO_CHECK_BUCKET=true

# Cifra un volcado y lo sube. Nunca hace fallar el bucle: una copia externa
# que falla se dice en el log y la local ya está hecha.
copia_externa() {
  origen="$1"
  # -z y no «está definida»: docker-compose.yml declara todas las variables,
  # así que una que no se ha configurado llega VACÍA (CLAUDE.md, trampa 4).
  if [ -z "${BACKUP_AGE_RECIPIENT:-}" ] || [ -z "${BACKUP_OFFSITE_ENDPOINT:-}" ] \
     || [ -z "${BACKUP_OFFSITE_BUCKET:-}" ] || [ -z "${BACKUP_OFFSITE_ACCESS_KEY_ID:-}" ] \
     || [ -z "${BACKUP_OFFSITE_SECRET_ACCESS_KEY:-}" ]; then
    echo "[backup] copia externa DESACTIVADA: faltan BACKUP_AGE_RECIPIENT o alguna BACKUP_OFFSITE_*"
    return 0
  fi

  cifrado="/tmp/$(basename "$origen").age"
  if ! age -r "$BACKUP_AGE_RECIPIENT" -o "$cifrado" "$origen"; then
    echo "[backup] copia externa FALLÓ al cifrar (¿BACKUP_AGE_RECIPIENT es una clave pública age válida?)"
    rm -f "$cifrado"
    return 0
  fi

  destino="externo:${BACKUP_OFFSITE_BUCKET}/kairikos-portal/$(basename "$cifrado")"
  if rclone copyto "$cifrado" "$destino" --retries 3 --low-level-retries 5 > /tmp/rclone.log 2>&1; then
    echo "[backup] copia externa OK: $destino ($(du -h "$cifrado" | cut -f1))"
  else
    echo "[backup] copia externa FALLÓ al subir a $destino:"
    tail -n 5 /tmp/rclone.log | sed 's/^/[backup]   /'
  fi
  rm -f "$cifrado"
}

echo "[backup] starting — dir=$BACKUP_DIR retention=${RETENTION_DAYS}d interval=${INTERVAL_SECONDS}s"

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/kairikos-portal-${stamp}.sql.gz"
  tmp="${out}.tmp"

  echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) dumping ${POSTGRES_DB} -> ${out}"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain | gzip > "$tmp"; then
    mv "$tmp" "$out"
    echo "[backup] OK: $(du -h "$out" | cut -f1)"
    copia_externa "$out"
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
