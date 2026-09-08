import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepPendingKnowledgeCrawls } from '@/lib/chatbot-knowledge-crawl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Fase 3 — GET /api/cron/crawl-knowledge
 *
 * Rastrea las páginas que el cliente encoló para la base de conocimiento
 * de su chatbot. Lo dispara scripts/scheduler.sh en la VPS; el horario de
 * vercel.json es inerte en Docker Compose (ver la cabecera de ese fichero).
 *
 * Idempotente y seguro de llamar de más, como el resto: solo mira
 * documentos en estado 'pending', y un documento que falla pasa a 'failed'
 * y deja de aparecer — nunca se reintenta solo. Con la cola vacía, que es
 * el caso normal, es una consulta y nada más.
 *
 * Misma autenticación que cualquier /api/cron/*:
 * `Authorization: Bearer <CRON_SECRET>`, cerrado si la variable no está.
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

  const result = await sweepPendingKnowledgeCrawls(prisma);
  return NextResponse.json({ ok: true, ...result });
}
