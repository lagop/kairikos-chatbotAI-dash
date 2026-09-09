import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepDueSiteAudits } from '@/lib/seo-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Fase 5 — GET /api/cron/audit-seo-sites
 *
 * "Es determinista y el scheduler ya lleva tres rutas de SEO. Una cuarta
 * que audite los perfiles sin auditoría reciente no necesita
 * infraestructura nueva" — la propia auditWebsite() ya decía, desde
 * Fase A, que su versión automática "reuses this same function, just
 * called from a cron tick instead of a button click". Esta es esa ruta.
 *
 * Misma convención de auth que cada /api/cron/* de este stack:
 * `Authorization: Bearer <CRON_SECRET>`, cierre en falso si no está
 * configurado. Y la misma trampa de siempre: sin entrada en
 * scripts/scheduler.sh este endpoint no se ejecuta nunca en la VPS —
 * ya está añadida en el mismo commit.
 */
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepDueSiteAudits(prisma);
  return NextResponse.json(result);
}
