#!/usr/bin/env bash
# scripts/vps-disk-cleanup.sh
#
# Limpieza periódica del disco de la VPS. CORRE EN LA VPS, por cron.
#
# Por qué existe (23/09/2026): el disco llegó al 100% —359 MB libres de
# 96 GB— y eso NO se manifestó como "disco lleno", sino como despliegues
# que se marcaban en verde y no cambiaban nada. La descarga de cada imagen
# fallaba con "no space left on device" y el paso de Hostinger daba SUCCESS
# igualmente, porque solo lanza la petición a su API y no espera. Durante
# horas se estuvo probando código que no estaba desplegado.
#
# El goteo es estructural: cada despliegue del portal deja una imagen de
# ~1,5 GB, y la anterior se queda sin etiqueta en el disco.
#
# QUÉ BORRA, y nada más:
#   - Caché de construcción por encima de KEEP_CACHE (solo caché: lo único
#     que se pierde es velocidad en la siguiente build).
#   - Imágenes SIN ETIQUETA, que es justo lo que deja cada despliegue.
#
# QUÉ NO BORRA, a propósito:
#   - Volúmenes. Ahí viven Postgres, n8n y las grabaciones. Nunca.
#   - Imágenes con etiqueta, aunque no las use ningún contenedor. En esta
#     máquina hay imágenes construidas EN LOCAL (kiraroom-backend:local,
#     kiraroom-frontend:local, 4,4 GB) que no se pueden volver a descargar
#     de ningún registro: borrarlas sería destruir trabajo.
#   - Contenedores parados, que pueden ser de otros proyectos de la VPS.
#
# Solo actúa por encima de UMBRAL_USO. Limpiar cada noche una caché que no
# estorba solo hace más lentas las builds sin ganar nada.
#
# Uso:
#   bash vps-disk-cleanup.sh              # limpia si toca
#   bash vps-disk-cleanup.sh --dry-run    # dice qué haría, sin tocar nada
#   bash vps-disk-cleanup.sh --force      # limpia aunque no se pase del umbral
set -Eeuo pipefail

UMBRAL_USO=75        # porcentaje de uso a partir del cual se limpia
KEEP_CACHE="4GB"     # caché de construcción que se conserva
MIN_LIBRE_GB=10      # por debajo de esto, se avisa a gritos en el log

MODO="normal"
case "${1:-}" in
  --dry-run) MODO="dry-run" ;;
  --force)   MODO="force" ;;
  "")        ;;
  *) echo "uso: $0 [--dry-run|--force]" >&2; exit 2 ;;
esac

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

uso_actual()   { df --output=pcent / | tail -1 | tr -dc '0-9'; }
libres_gb()    { df --output=avail --block-size=G / | tail -1 | tr -dc '0-9'; }

USO_ANTES=$(uso_actual)
LIBRES_ANTES=$(libres_gb)
log "disco al ${USO_ANTES}% (${LIBRES_ANTES} GB libres), umbral ${UMBRAL_USO}%"

if [[ "$MODO" != "force" && "$USO_ANTES" -lt "$UMBRAL_USO" ]]; then
  log "por debajo del umbral: no se toca nada."
  exit 0
fi

if [[ "$MODO" == "dry-run" ]]; then
  log "--dry-run: esto es lo que hay, sin borrar nada"
  docker system df
  exit 0
fi

log "limpiando caché de construcción (se conservan ${KEEP_CACHE})..."
docker builder prune -f --keep-storage "$KEEP_CACHE" 2>&1 | tail -1 | sed 's/^/  /'

log "limpiando imágenes sin etiqueta..."
docker image prune -f 2>&1 | tail -1 | sed 's/^/  /'

USO_DESPUES=$(uso_actual)
LIBRES_DESPUES=$(libres_gb)
log "disco al ${USO_DESPUES}% (${LIBRES_DESPUES} GB libres) — recuperados $((LIBRES_DESPUES - LIBRES_ANTES)) GB"

# El aviso que importa: si después de limpiar sigue habiendo poco sitio, el
# problema ya no es la basura de los despliegues y hace falta una persona.
# Lo siguiente que se llena es lo que rompe los despliegues en silencio.
if [[ "$LIBRES_DESPUES" -lt "$MIN_LIBRE_GB" ]]; then
  log "AVISO: quedan ${LIBRES_DESPUES} GB después de limpiar (mínimo sano: ${MIN_LIBRE_GB} GB)."
  log "AVISO: mira qué ocupa —'docker system df' y 'du -xh --max-depth=2 / | sort -h | tail -20'."
  exit 1
fi

log "hecho."
