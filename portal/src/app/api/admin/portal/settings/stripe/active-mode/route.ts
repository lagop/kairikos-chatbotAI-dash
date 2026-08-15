import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { getStripeCredentialStatus, setActiveStripeMode } from '@/lib/stripe-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ mode: z.enum(['test', 'live']) });

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { mode } = body.data;

  const status = await getStripeCredentialStatus();
  const configured = mode === 'test' ? status.test.configured : status.live.configured;
  if (!configured) {
    return NextResponse.json({ error: 'credential_not_configured_for_mode', mode }, { status: 409 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  await setActiveStripeMode(mode, { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null });

  return NextResponse.json({ ok: true, activeMode: mode });
}
