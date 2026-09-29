#!/bin/sh
# =============================================================================
# Kairikos — restore a Postgres dump produced by scripts/backup-postgres.sh.
#
# Run this ON THE VPS HOST (not inside a container), from the repo root,
# where `docker compose` can see the running stack:
#
#   ./scripts/restore-postgres.sh backups/kairikos-portal-20260101T030000Z.sql.gz
#
# This restores into a FRESH throwaway database by default (never the
# live `kairikos_portal` DB) so a restore drill never risks the real
# data — see "Restoring over the live database" below for the
# deliberate, explicit way to do that instead.
#
# Test this at least once right after the first real deploy. A backup
# nobody has restored is not a backup.
#
# COPIAS EXTERNAS (29/09/2026). Las copias que scripts/backup-postgres.sh sube
# fuera acaban en .sql.gz.age: están cifradas con age. Para restaurar una hace
# falta la clave PRIVADA, que no está en la VPS (la guarda el titular fuera de
# línea). Se le pasa la ruta en AGE_IDENTITY:
#
#   AGE_IDENTITY=/ruta/a/clave-privada.txt ./scripts/restore-postgres.sh copia.sql.gz.age
#
# Hace falta el programa age en la máquina donde se ejecute
# (https://age-encryption.org). Descifrar en la VPS obliga a copiar allí la
# clave privada: mejor descifrar en local, quedarse con el .sql.gz y subir
# solo ese.
# =============================================================================

set -eu

DUMP_FILE="${1:?Usage: $0 <path-to-dump.sql.gz>}"
if [ ! -f "$DUMP_FILE" ]; then
  echo "No such file: $DUMP_FILE" >&2
  exit 1
fi

TARGET_DB="${RESTORE_TARGET_DB:-kairikos_portal_restore_check}"

# Cómo leer el volcado: tal cual (.sql.gz) o descifrándolo antes (.sql.gz.age).
case "$DUMP_FILE" in
  *.age)
    if [ -z "${AGE_IDENTITY:-}" ] || [ ! -f "${AGE_IDENTITY}" ]; then
      echo "Es una copia cifrada: pasa la clave privada en AGE_IDENTITY=/ruta/a/la/clave" >&2
      exit 1
    fi
    command -v age >/dev/null 2>&1 || { echo "Falta el programa age: https://age-encryption.org" >&2; exit 1; }
    leer_volcado() { age -d -i "$AGE_IDENTITY" "$DUMP_FILE" | gunzip -c; }
    ;;
  *)
    leer_volcado() { gunzip -c "$DUMP_FILE"; }
    ;;
esac

echo "== Restoring $DUMP_FILE into a throwaway DB '$TARGET_DB' on the postgres container =="
echo "   (the live 'kairikos_portal' DB is NOT touched by this default path)"

docker compose exec -T postgres psql -U "${POSTGRES_USER:-kairikos}" -d postgres \
  -c "DROP DATABASE IF EXISTS ${TARGET_DB};" \
  -c "CREATE DATABASE ${TARGET_DB};"

leer_volcado | docker compose exec -T postgres psql -U "${POSTGRES_USER:-kairikos}" -d "$TARGET_DB"

echo "== Done. Sanity-check row counts, e.g.: =="
echo "   docker compose exec postgres psql -U ${POSTGRES_USER:-kairikos} -d ${TARGET_DB} -c '\\dt'"
echo ""
echo "== Restoring over the live database (deliberate, destructive — confirm you mean this) =="
echo "   1. docker compose stop app"
echo "   2. docker compose exec postgres psql -U \$POSTGRES_USER -d postgres \\"
echo "        -c \"DROP DATABASE ${POSTGRES_DB:-kairikos_portal};\" \\"
echo "        -c \"CREATE DATABASE ${POSTGRES_DB:-kairikos_portal};\""
echo "   3. gunzip -c $DUMP_FILE | docker compose exec -T postgres psql -U \$POSTGRES_USER -d ${POSTGRES_DB:-kairikos_portal}"
echo "   4. docker compose start app"
