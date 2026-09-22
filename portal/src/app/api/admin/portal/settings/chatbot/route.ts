import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getChatbotMessageCaps,
  updateChatbotMessageCaps,
  MIN_MESSAGE_CAP,
  MAX_MESSAGE_CAP,
} from '@/lib/chatbot-settings';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Chatbot — GET/POST /api/admin/portal/settings/chatbot
//
// El tope de mensajes al mes por tarifa. Mismo molde que la ruta de ajustes
// de SEO: solo operador, sin TOTP — no es un secreto ni una credencial de
// pago, y el peor caso de un valor equivocado es un bot que deja de
// responder antes de tiempo o una factura mayor de la prevista, no un
// incidente de seguridad.
//
// Por qué hay tope: ver la cabecera de lib/chatbot-settings.ts.
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const caps = await getChatbotMessageCaps();
  return NextResponse.json({ caps });
}

const CapSchema = z.number().int().min(MIN_MESSAGE_CAP).max(MAX_MESSAGE_CAP);

const BodySchema = z.object({
  starter: CapSchema,
  pro: CapSchema,
  premium: CapSchema,
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  try {
    const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    await updateChatbotMessageCaps(body.data, operator?.email ?? null);
  } catch (err) {
    logError('chatbot_settings.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, caps: body.data });
}
