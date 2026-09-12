# =============================================================================
# Kairikos — the `scheduler` service's image.
#
# Why this exists: docker-compose.yml used to bind-mount
# `./scripts/scheduler.sh` straight from the VPS host filesystem. That
# works for local dev, but the Hostinger deploy pipeline only ever
# syncs docker-compose.yml's own CONTENT to the VPS — never the rest of
# the repo — so the host's copy of this script was whatever got
# manually placed there at initial provisioning, and every later change
# to scripts/scheduler.sh in git silently never reached production.
# Confirmed directly: the running scheduler container's ENDPOINTS list
# was still missing entries added weeks earlier.
#
# Fix: bake the script into its own tiny image instead, built and
# pushed by build-support-images.yml on every change — the same
# image-based deploy path that already works correctly for the main
# `app` service (see docker-compose.yml's `pull_policy: always` on this
# service for the other half of that fix: actually picking up a new
# image on deploy, not just building one).
FROM curlimages/curl:8.11.0
COPY scripts/scheduler.sh /scheduler.sh
ENTRYPOINT ["/bin/sh", "/scheduler.sh"]
