import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getOperatorAlertSettingsView,
  normaliseAlertSettings,
  updateOperatorAlertSettings,
} from '@/lib/operator-alert-settings';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// GET/POST /api/admin/portal/settings/alerts — a quién le llegan las alertas
// de operador. Ver lib/operator-alert-settings.ts.
//
// Mismo esqueleto que settings/seo: sesión de operador, sin TOTP. No es un
// secreto ni una credencial de pago; lo peor de un valor equivocado es que
// una alerta llegue a otra bandeja, y eso se ve en la propia pantalla.
//
// Quién guardó queda en updatedBy. Con la API key heredada se guarda como
// 'legacy_operator', igual que en SEO: aquí no hay nada que atribuir más
// allá de "quién tocó el destinatario".
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  return NextResponse.json(await getOperatorAlertSettingsView());
}

const BodySchema = z.object({
  operatorEmails: z.string().max(2000),
  ceoEmail: z.string().max(320),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const normalised = normaliseAlertSettings(body.data);
  if (!normalised.ok) {
    return NextResponse.json(normalised, { status: 400 });
  }

  try {
    const isLegacyAuth = auth.operatorId === 'legacy';
    const operator = isLegacyAuth
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    await updateOperatorAlertSettings(
      { operatorEmails: normalised.operatorEmails, ceoEmail: normalised.ceoEmail },
      operator?.email ?? (isLegacyAuth ? 'legacy_operator' : null),
    );
  } catch (err) {
    logError('operator_alert_settings.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...(await getOperatorAlertSettingsView()) });
}
