import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { TIER_LEAD_CAP } from '@/lib/prospecting';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Prospección con IA, Fase A — PATCH /api/portal/prospecting/campaign
//
// Client self-serve, deliberately: see prospecting.ts's header and the
// session's own plan for why this is NOT an operator-managed setting —
// there is no technical complexity here (unlike Meta Coexistence) that
// would justify intermediation, and putting the operator in the loop
// for every zone/category change works against why this product exists.
//
// Fase 6 — the row itself is normally already there by the time this
// runs: ensureProspectingCampaign (product-onboarding.ts) creates it
// empty at purchase time, with monthlyLeadCap already set from the
// contracted tier. The lazy `create` below stays as the fallback for a
// row that predates that hook, or the rare case where the hook's own
// write failed silently — this PATCH must keep working either way.
// =============================================================================

const OPTIONAL_TEXT = z.string().trim().max(2000).nullish();

const BodySchema = z.object({
  category: z.string().trim().min(1).max(200),
  locationQuery: z.string().trim().min(1).max(200),
  radiusMeters: z.number().int().min(500).max(50000).optional(),
  // Fase A — el contexto del negocio del cliente, con el que se le sugieren
  // rubros y zonas (ver prospecting-brief-ai.ts). Opcional: quien ya sabe a
  // quién buscar sigue guardando solo rubro y zona, como hasta ahora.
  clientWebsite: z.string().trim().max(500).nullish(),
  businessDescription: OPTIONAL_TEXT,
  idealCustomer: OPTIONAL_TEXT,
  exclusions: OPTIONAL_TEXT,
});

/** Solo los campos del brief que vinieron en la petición: lo que no se manda
 *  no se pisa, y una cadena vacía borra. */
function briefFields(data: z.infer<typeof BodySchema>) {
  const out: Record<string, string | null> = {};
  for (const key of ['clientWebsite', 'businessDescription', 'idealCustomer', 'exclusions'] as const) {
    const value = data[key];
    if (value !== undefined) out[key] = value && value.length > 0 ? value : null;
  }
  return out;
}

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
    select: { id: true, tenantId: true, product: { select: { tier: true } } },
  });
  if (!clientProduct) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const existing = await prisma.prospectingCampaign.findUnique({
    where: { clientProductId: clientProduct.id },
    select: { id: true, category: true, locationQuery: true, radiusMeters: true },
  });

  let campaign;
  try {
    if (existing) {
      const before = { category: existing.category, locationQuery: existing.locationQuery, radiusMeters: existing.radiusMeters };
      campaign = await prisma.$transaction(async (tx) => {
        const updated = await tx.prospectingCampaign.update({
          where: { id: existing.id },
          data: {
            category: body.data.category,
            locationQuery: body.data.locationQuery,
            ...(body.data.radiusMeters !== undefined ? { radiusMeters: body.data.radiusMeters } : {}),
            ...briefFields(body.data),
          },
        });
        await tx.prospectingCampaignAudit.create({
          data: {
            campaignId: updated.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'profile_updated',
            before,
            after: { category: updated.category, locationQuery: updated.locationQuery, radiusMeters: updated.radiusMeters },
            actorId: `client:${resolved.clientId}`,
          },
        });
        return updated;
      });
    } else {
      campaign = await prisma.$transaction(async (tx) => {
        const created = await tx.prospectingCampaign.create({
          data: {
            clientId: resolved.clientId,
            clientProductId: clientProduct.id,
            tenantId: clientProduct.tenantId,
            category: body.data.category,
            locationQuery: body.data.locationQuery,
            ...(body.data.radiusMeters !== undefined ? { radiusMeters: body.data.radiusMeters } : {}),
            ...briefFields(body.data),
            monthlyLeadCap: TIER_LEAD_CAP[clientProduct.product.tier] ?? TIER_LEAD_CAP.solo,
          },
        });
        await tx.prospectingCampaignAudit.create({
          data: {
            campaignId: created.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'created',
            before: Prisma.JsonNull,
            after: { category: created.category, locationQuery: created.locationQuery, radiusMeters: created.radiusMeters },
            actorId: `client:${resolved.clientId}`,
          },
        });
        return created;
      });
    }
  } catch (err) {
    logError('prospecting_campaign.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    campaign: { category: campaign.category, locationQuery: campaign.locationQuery, radiusMeters: campaign.radiusMeters },
  });
}
