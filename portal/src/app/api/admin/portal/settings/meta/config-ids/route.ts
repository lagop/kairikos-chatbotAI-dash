import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { saveMetaConfigIds } from '@/lib/meta-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  configId: z.string().min(1),
  coexistenceConfigId: z.string().min(1),
});

/**
 * POST /api/admin/portal/settings/meta/config-ids
 *
 * Saves the two Embedded Signup Configuration ids (standard chatbot
 * channels + recall's Coexistence). Deliberately lighter than the app
 * credential route: neither value is secret, so no TOTP step-up and no
 * verify-against-Meta round trip — see saveMetaConfigIds's header for
 * the full reasoning. Still requires a real admin session; this is a
 * settings mutation, just not one of the two gated behind step-up.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { configId, coexistenceConfigId } = body.data;

  // The legacy x-kaia-operator-key path's 'legacy' sentinel is not a
  // real Operator row id — passing it straight through would fail the
  // audit insert's actorOperatorId FK (a Uuid column) and, since that
  // insert shares a transaction with the actual save, roll back the
  // whole thing. null is the correct "no real operator identity" value.
  const operatorId = auth.operatorId === 'legacy' ? null : auth.operatorId;
  try {
    const operator = operatorId
      ? await prisma.operator.findUnique({ where: { id: operatorId }, select: { email: true } })
      : null;
    await saveMetaConfigIds(configId, coexistenceConfigId, {
      operatorId,
      operatorEmail: operator?.email ?? null,
    });
  } catch (err) {
    logError('meta_credentials.save_config_ids_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, configId, coexistenceConfigId });
}
