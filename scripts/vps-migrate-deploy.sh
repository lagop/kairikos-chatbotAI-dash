#!/usr/bin/env bash
# scripts/vps-migrate-deploy.sh
#
# Aplica contra el Postgres REAL de la VPS cualquier migración de Prisma
# que el código ya tenga escrita pero la base de datos todavía no —
# lo que en CLAUDE.md (trampa 3) solo se documentaba para desarrollo local
# (`db execute` + `migrate resolve --applied`, a mano, migración a
# migración). Esto es el equivalente de producción: `prisma migrate deploy`,
# que aplica TODAS las pendientes en orden y es un no-op seguro si ya
# estaban aplicadas.
#
# SE EJECUTA EN LA VPS, nunca desde fuera:
#   ssh -i ~/.ssh/kairikos_vps root@<host> 'bash -s' < scripts/vps-migrate-deploy.sh
#   ssh -i ~/.ssh/kairikos_vps root@<host> 'bash -s -- --apply' < scripts/vps-migrate-deploy.sh
#
# Por qué no se puede hacer más simple:
#   - El contenedor de producción (kairikos-portal-app) NO lleva el CLI de
#     Prisma, solo el cliente ya generado (ver portal/Dockerfile — es
#     deliberado, para no inflar la imagen de runtime).
#   - Postgres no está publicado fuera de la red interna de Docker de la
#     VPS — no hay forma de conectarse desde un portátil sin un túnel.
#
# La solución: clonar una copia aislada y temporal del repo en la propia
# VPS (nunca tocar /root/kairikos-portal — ese checkout tiene cambios sin
# commitear que gestiona el propio pipeline de Hostinger, y un `git pull`
# ahí puede chocar con ellos), y correr un contenedor de un solo uso en la
# MISMA red que Postgres.
#
# Dos tropiezos reales la primera vez que se hizo esto a mano (20/09/2026),
# ambos fijados explícitamente aquí:
#   1. `npx prisma` sin versión descarga la última del registro de npm (hoy
#      7.x), que ya no soporta `url = env(...)` directo en el datasource de
#      schema.prisma — este repo sigue en prisma@^5.22.0
#      (portal/package.json). Sin fijar la versión, falla con un error de
#      validación de esquema que no tiene nada que ver con la causa real.
#   2. La imagen node:20-bookworm-slim no trae openssl instalado, y el
#      motor nativo de Prisma lo necesita para arrancar — sin él falla con
#      "Schema engine error:" y NADA más, un error vacío que no apunta a
#      la causa.
#
# Por defecto es de solo lectura (`migrate status`) — hace falta el flag
# --apply explícito para escribir de verdad. Nunca imprime la contraseña
# de Postgres: se extrae del .env real de la VPS dentro del propio
# contenedor, nunca sale de ahí.
#
# Exit codes:
#   0 — status u aplicación correctos (o ya estaba todo al día)
#   1 — no se encuentra el checkout de referencia
#   2 — no se pudo averiguar la red de Postgres
set -Eeuo pipefail

REPO_CHECKOUT="/root/kairikos-portal"
TMP_DIR="/root/kairikos-migrate-tmp"
PRISMA_VERSION="5.22.0"
BRANCH="kaia-743-staging-runner"
REMOTE_URL="https://github.com/lagop/kairikos-chatbotAI-dash.git"

MODE="status"
if [[ "${1:-}" == "--apply" ]]; then
  MODE="deploy"
fi

log() { printf '[vps-migrate] %s\n' "$*"; }

if [[ ! -d "$REPO_CHECKOUT/.git" ]]; then
  echo "FATAL: no se encuentra $REPO_CHECKOUT — ajusta REPO_CHECKOUT." >&2
  exit 1
fi

NETWORK="$(docker inspect kairikos-portal-postgres --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
if [[ -z "$NETWORK" ]]; then
  echo "FATAL: no se pudo averiguar la red de Postgres (¿está corriendo el contenedor?)." >&2
  exit 2
fi
log "red de Postgres: $NETWORK"

log "clonando una copia aislada en $TMP_DIR (sin tocar $REPO_CHECKOUT)..."
rm -rf "$TMP_DIR"
git clone --quiet "$REPO_CHECKOUT" "$TMP_DIR"
(
  cd "$TMP_DIR"
  git remote set-url origin "$REMOTE_URL"
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
)
log "checkout en $(git -C "$TMP_DIR" log -1 --oneline)"

POSTGRES_USER="$(grep -oP '^POSTGRES_USER=\K.*' "$REPO_CHECKOUT/.env")"
POSTGRES_PASSWORD="$(grep -oP '^POSTGRES_PASSWORD=\K.*' "$REPO_CHECKOUT/.env")"
POSTGRES_DB="$(grep -oP '^POSTGRES_DB=\K.*' "$REPO_CHECKOUT/.env")"
DB_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"

log "modo: $MODE (usa --apply para escribir de verdad; sin él, solo consulta)"
docker run --rm --network "$NETWORK" \
  -v "$TMP_DIR/portal:/app" -w /app \
  -e DATABASE_URL="$DB_URL" -e DIRECT_URL="$DB_URL" \
  node:20-bookworm-slim \
  bash -c "apt-get update -y >/dev/null 2>&1 && apt-get install -y openssl >/dev/null 2>&1 && npx --yes prisma@${PRISMA_VERSION} migrate $MODE"

log "limpiando $TMP_DIR..."
rm -rf "$TMP_DIR"
log "hecho."
