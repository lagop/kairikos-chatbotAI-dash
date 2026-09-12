# =============================================================================
# Kairikos — the `backup` service's image. Same reasoning as
# scheduler.Dockerfile (see that file's header comment for the full
# story): scripts/backup-postgres.sh used to be bind-mounted from the
# VPS host, where it never got updated after the initial provisioning.
# Baked into its own image instead, built by build-support-images.yml.
FROM postgres:16-alpine
COPY scripts/backup-postgres.sh /backup-postgres.sh
ENTRYPOINT ["/bin/sh", "/backup-postgres.sh"]
