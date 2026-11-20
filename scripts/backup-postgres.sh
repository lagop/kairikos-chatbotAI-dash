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
#
# FOTOS DE LA CARTERA (20/11/2026). Las fotos que suben las agencias no
# están en Postgres: viven en el volumen cartera-fotos (decisión A de
# docs/fase1-cartera.md de la plantilla), y hasta hoy no las copiaba nadie.
# Ahora, en cada pasada y después del volcado, se guarda el volumen en
# $BACKUP_DIR/kairikos-portal-cartera-fotos-AAAAMMDD.tar (montado aquí en
# solo lectura en /cartera-fotos):
#
#   - Un archivo por DÍA (UTC), no por pasada: este contenedor se reinicia
#     con cada despliegue y cada reinicio es una pasada, así que en un día
#     de muchos despliegues habría decenas de copias iguales.
#   - Sin cambios desde la última copia (misma lista de archivos, tamaños y
#     fechas), no se vuelve a empaquetar: el archivo de hoy es un ENLACE
#     DURO al anterior, que no ocupa más disco. El 23/09/2026 el disco de
#     la VPS se llenó y dejó de desplegar sin avisar; catorce copias
#     completas de unas fotos que no cambian serían otra forma de llenarlo.
#   - Sin gzip: JPEG y WebP ya van comprimidos.
#   - La retención es la misma que la de los volcados, pero se cuenta por
#     la FECHA DEL NOMBRE y no por la fecha del archivo: un enlace duro
#     comparte la fecha del original, y borrar por ella se llevaría también
#     la copia de hoy. Así, una cartera purgada (baja + 30 días) desaparece
#     de las copias locales RETENTION_DAYS días después, como un volcado.
#   - Cada archivo nuevo pasa por la misma copia externa cifrada.
#
# Restaurar: `tar -xf kairikos-portal-cartera-fotos-AAAAMMDD.tar -C <dir>`
# deja las carpetas <siteId>/<homeId>/<foto> tal como las espera el portal
# (CARTERA_FOTOS_DIR), y las filas que las citan vuelven con el volcado del
# mismo día.
# =============================================================================

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
PHOTOS_DIR=/cartera-fotos
PHOTOS_PREFIX="kairikos-portal-cartera-fotos"

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

# La copia de las fotos de la cartera (ver la cabecera). Nunca hace fallar
# el bucle: el volcado de Postgres de esta pasada ya está hecho.
copia_fotos() {
  if [ ! -d "$PHOTOS_DIR" ]; then
    echo "[backup] fotos: $PHOTOS_DIR no está montado, se salta"
    return 0
  fi
  # Lista de archivos con tamaño y fecha: si no cambia, las fotos tampoco.
  # busybox: sin `find -printf`, así que stat.
  # Con `if !`: una asignación que falla dentro de `set -e` mataría el bucle.
  if ! lista="$(cd "$PHOTOS_DIR" && find . -type f -exec stat -c '%n %s %Y' {} + | sort)"; then
    echo "[backup] fotos: FALLÓ al leer $PHOTOS_DIR"
    return 0
  fi
  if [ -z "$lista" ]; then
    echo "[backup] fotos: el volumen está vacío, nada que copiar"
    return 0
  fi
  huella="$(printf '%s\n' "$lista" | sha256sum | cut -d' ' -f1)"
  hoy="$BACKUP_DIR/${PHOTOS_PREFIX}-$(date -u +%Y%m%d).tar"
  estado="$BACKUP_DIR/${PHOTOS_PREFIX}.huella"
  anterior=""
  if [ -f "$estado" ]; then
    read -r huella_anterior anterior < "$estado" || true
    [ "${huella_anterior:-}" = "$huella" ] && [ -f "$anterior" ] || anterior=""
  fi

  if [ -n "$anterior" ] && [ "$anterior" = "$hoy" ]; then
    echo "[backup] fotos: sin cambios desde $(basename "$hoy")"
    return 0
  fi
  if [ -n "$anterior" ]; then
    # Las mismas fotos que la última copia: enlace duro, sin ocupar más.
    # Enlace a un nombre temporal y mv: el de hoy puede existir (otra copia
    # de hoy, más vieja) y ln no lo sustituiría.
    if ln "$anterior" "${hoy}.tmp" && mv "${hoy}.tmp" "$hoy"; then
      echo "[backup] fotos: sin cambios desde $(basename "$anterior"), enlazada como $(basename "$hoy")"
    else
      echo "[backup] fotos: FALLÓ el enlace a $(basename "$anterior")"
      rm -f "${hoy}.tmp"
      return 0
    fi
  else
    if tar -cf "${hoy}.tmp" -C "$PHOTOS_DIR" .; then
      mv "${hoy}.tmp" "$hoy"
      echo "[backup] fotos OK: $(basename "$hoy") ($(printf '%s\n' "$lista" | wc -l) archivos, $(du -h "$hoy" | cut -f1))"
    else
      echo "[backup] fotos FALLÓ al empaquetar — no queda archivo a medias"
      rm -f "${hoy}.tmp"
      return 0
    fi
  fi
  printf '%s %s\n' "$huella" "$hoy" > "$estado"
  copia_externa "$hoy"
}

# Borra las copias de fotos de más de RETENTION_DAYS días por la fecha del
# NOMBRE (ver la cabecera: un enlace duro comparte la fecha del original).
podar_fotos() {
  limite="$(date -u -d "@$(( $(date +%s) - RETENTION_DAYS * 86400 ))" +%Y%m%d)"
  for f in "$BACKUP_DIR/${PHOTOS_PREFIX}"-*.tar; do
    [ -e "$f" ] || continue
    dia="$(basename "$f" .tar)"
    dia="${dia##*-}"
    case "$dia" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
      *) continue ;;
    esac
    if [ "$dia" -lt "$limite" ]; then
      rm -f "$f"
      echo "[backup] pruned: $f"
    fi
  done
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

  copia_fotos
  podar_fotos

  sleep "$INTERVAL_SECONDS" &
  wait $!
done
