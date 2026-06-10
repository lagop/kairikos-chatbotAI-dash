# =============================================================================
# Kairikos portal — Next.js production image (KAIA-754 / CTO follow-up)
#
# Multi-stage build to keep the runtime image small:
#   deps    — installs only production deps
#   builder — installs all deps, runs prisma generate, builds Next.js
#   runner  — minimal Node 20-alpine, non-root user, runs `next start`
#
# Health check is wired to /api/health (a small endpoint that returns 200
# with {"status":"ok"} — see src/app/api/health/route.ts).
# =============================================================================

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY portal/package.json portal/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY portal/package.json portal/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portal/ ./
# Prisma needs DATABASE_URL at generate time; a placeholder is fine because
# the schema doesn't introspect the database — it just generates the client.
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npm run build

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache openssl curl \
    && addgroup --system --gid 1001 nodejs \
    && adduser  --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public 2>/dev/null || true
COPY --from=deps    --chown=nextjs:nodejs /app/node_modules    ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma         ./prisma
COPY --from=builder                /usr/local/lib/node_modules/prisma ./prisma-bin 2>/dev/null || true

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
