# =============================================================================
# Kairikos — the `backup` service's image. Same reasoning as
# scheduler.Dockerfile (see that file's header comment for the full
# story): scripts/backup-postgres.sh used to be bind-mounted from the
# VPS host, where it never got updated after the initial provisioning.
# Baked into its own image instead, built by build-support-images.yml.
FROM postgres:16-alpine
# 29/09/2026 — la copia externa: age cifra cada volcado con una clave
# PÚBLICA (la privada no está en la VPS) y rclone lo sube a un almacenamiento
# compatible con S3 en la UE. Ver la cabecera de backup-postgres.sh.
RUN apk add --no-cache age rclone
COPY scripts/backup-postgres.sh /backup-postgres.sh
ENTRYPOINT ["/bin/sh", "/backup-postgres.sh"]
