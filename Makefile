# Kairikos Portal — top-level Makefile
# This file is intentionally minimal. The portal's actual build/lint/test
# commands live in portal/package.json. Add repo-level convenience targets
# here (cross-repo checks, secret scans, etc.).

.PHONY: secrets-check

secrets-check:
	@bash scripts/secrets-check.sh
