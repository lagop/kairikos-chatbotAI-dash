import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PROSPECTING_CONSENT_VERSION } from '@/lib/prospecting-contact';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Prospección con IA, Fase C — PATCH /api/portal/prospecting/campaign/consent
//
// A separate route from PATCH .../campaign on purpose: that route saves a
// plain settings form (rubro/zona/radio); this one is the client
// explicitly authorizing automatic WhatsApp contact from their own
// number, which deserves its own distinct audit action
// ('consent_given'/'consent_revoked'), not folded into 'profile_updated'.
//
// Requires an existing ProspectingCampaign row — consenting before the
// client has even set a target profile is meaningless, and the campaign
// is only ever created by PATCH .../campaign's lazy-create, not here.
//
// consent:true also clears autoContactPausedAt — this IS the resume
// mechanism after a quality-triggered auto-pause (see
// prospecting-contact.ts's header for why that pause doesn't clear
// itself). consent:false (revoking) clears it too, since a revoked
// campaign has nothing left to be paused from.
// =============================================================================

const BodySchema = z.object({ consent: z.boolean() });

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId: resolved.clientId, status: 'active', product: { code: 'prospecting' } },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const existing = await prisma.prospectingCampaign.findUnique({
    where: { clientProductId: clientProduct.id },
    select: { id: true, consentVersion: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'not_found', detail: 'guarda tu perfil de busqueda primero' }, { status: 404 });
  }

  const now = new Date();
  const consent = body.data.consent;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.prospectingCampaign.update({
        where: { id: existing.id },
        data: consent
          ? { consentAcknowledgedAt: now, consentVersion: PROSPECTING_CONSENT_VERSION, autoContactPausedAt: null }
          : { consentAcknowledgedAt: null, consentVersion: null, autoContactPausedAt: null },
      });
      await tx.prospectingCampaignAudit.create({
        data: {
          campaignId: row.id,
          clientId: resolved.clientId,
          tenantId: clientProduct.tenantId,
          action: consent ? 'consent_given' : 'consent_revoked',
          before: existing.consentVersion ? { consentVersion: existing.consentVersion } : Prisma.JsonNull,
          after: { consentVersion: row.consentVersion },
          actorId: `client:${resolved.clientId}`,
        },
      });
      return row;
    });

    return NextResponse.json({
      ok: true,
      campaign: {
        consentAcknowledgedAt: updated.consentAcknowledgedAt?.toISOString() ?? null,
        autoContactPausedAt: updated.autoContactPausedAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    logError('prospecting_campaign_consent.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
