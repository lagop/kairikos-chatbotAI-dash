import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 7 — GET/PATCH /api/portal/conversation-digests/schedule
//
// Gated on getSession() (real session, not just resolveClientFromSession()'s
// dev-mock fallback) then isProductContracted('chatbot') — same double
// gate as the channel-connect routes (Fase 2/3), since this is a
// chatbot-only feature.
// =============================================================================

const BodySchema = z.object({
  enabled: z.boolean(),
  preset: z.enum(['morning_noon_evening', 'custom_interval']),
  intervalHours: z.number().int().min(1).max(168).nullable().optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
});

async function authorize() {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) } as const;
  }
  if (!isDatabaseConfigured) {
    return { error: NextResponse.json({ error: 'service_unavailable' }, { status: 503 }) } as const;
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) } as const;
  }
  if (resolved.source !== 'database') {
    return { error: NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 }) } as const;
  }
  const hasChatbot = await isProductContracted(prisma, resolved.clientId, CHATBOT_PRODUCT_CODE);
  if (!hasChatbot) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) } as const;
  }
  return { resolved } as const;
}

export async function GET() {
  const auth = await authorize();
  if ('error' in auth) return auth.error;

  const schedule = await prisma.conversationDigestSchedule.findUnique({
    where: { clientId: auth.resolved.clientId },
  });

  return NextResponse.json({
    schedule: schedule
      ? {
          enabled: schedule.enabled,
          preset: schedule.preset,
          intervalHours: schedule.intervalHours,
          timezone: schedule.timezone,
          lastGeneratedAt: schedule.lastGeneratedAt?.toISOString() ?? null,
        }
      : { enabled: false, preset: 'morning_noon_evening', intervalHours: null, timezone: 'Europe/Madrid', lastGeneratedAt: null },
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await authorize();
  if ('error' in auth) return auth.error;

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  if (body.data.preset === 'custom_interval' && !body.data.intervalHours) {
    return NextResponse.json({ error: 'invalid_body', detail: 'intervalHours_required_for_custom_interval' }, { status: 400 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: auth.resolved.clientId },
    select: { tenantId: true },
  });

  const data = {
    enabled: body.data.enabled,
    preset: body.data.preset,
    intervalHours: body.data.preset === 'custom_interval' ? body.data.intervalHours ?? null : null,
    timezone: body.data.timezone ?? 'Europe/Madrid',
  };

  const updated = await prisma.conversationDigestSchedule.upsert({
    where: { clientId: auth.resolved.clientId },
    update: data,
    create: { clientId: auth.resolved.clientId, tenantId: client?.tenantId ?? null, ...data },
  });

  return NextResponse.json({
    schedule: {
      enabled: updated.enabled,
      preset: updated.preset,
      intervalHours: updated.intervalHours,
      timezone: updated.timezone,
      lastGeneratedAt: updated.lastGeneratedAt?.toISOString() ?? null,
    },
  });
}
