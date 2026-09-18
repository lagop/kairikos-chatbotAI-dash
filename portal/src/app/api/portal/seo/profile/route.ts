import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { resolveContractedInstance } from '@/lib/client-product-access';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA, Fase A — PATCH /api/portal/seo/profile
//
// The client's half of SeoProfile's column-segmented onboarding (see the
// model's schema comment): business context + which site/CMS. The
// technical publish access (WordPress URL/Application Password) is the
// OPERATOR's half — PATCH /api/admin/portal/seo/[clientId]/technical-setup
// — never written here.
//
// Fase 6 — the row itself is normally already there by the time this
// runs: ensureSeoProfile (product-onboarding.ts) creates it empty at
// purchase time, from both the Stripe checkout webhook and the manual
// admin assignment route. The lazy `create` below stays as the fallback
// for a row that predates that hook, or the rare case where the hook's
// own write failed silently — this PATCH must keep working either way,
// since it has no way to tell those two situations apart from a normal
// first save.
// =============================================================================

const BodySchema = z
  .object({
    businessDescription: z.string().trim().min(1).max(2000).optional(),
    targetAudience: z.string().trim().min(1).max(1000).optional(),
    toneOfVoice: z.string().trim().min(1).max(500).optional(),
    siteUrl: z.string().trim().url().max(500).optional(),
    cmsType: z.enum(['wordpress', 'wix', 'squarespace', 'other', 'no_se']).optional(),
    // Fase 2 multi-instancia — de qué web se está hablando. Opcional: sin él
    // se resuelve la única contratación de 'seo' que haya, que es lo que
    // hacía este endpoint antes.
    clientProductId: z.string().uuid().optional(),
  })
  // clientProductId NO cuenta como "campo": es el selector de a cuál de las
  // webs se escribe, no algo que se escriba. Un cuerpo que solo lo traiga
  // sigue siendo un PATCH vacío.
  .refine(
    ({ clientProductId: _ignored, ...fields }) => Object.values(fields).some((v) => v !== undefined),
    { message: 'at least one field must be provided' },
  );

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

  // Fase 2 multi-instancia — esto resolvía con un findFirst por cliente, sin
  // orden estable: con dos webs habría escrito en una de las dos al azar, y no
  // necesariamente la misma entre dos guardados seguidos.
  const instance = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: 'seo',
    clientProductId: body.data.clientProductId ?? null,
  });
  if (!instance) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const clientProduct = { id: instance.clientProductId, tenantId: instance.tenantId };

  const existing = await prisma.seoProfile.findUnique({
    where: { clientProductId: clientProduct.id },
    select: { id: true, businessDescription: true, targetAudience: true, toneOfVoice: true, siteUrl: true, cmsType: true },
  });

  const fields = {
    businessDescription: body.data.businessDescription,
    targetAudience: body.data.targetAudience,
    toneOfVoice: body.data.toneOfVoice,
    siteUrl: body.data.siteUrl,
    cmsType: body.data.cmsType,
  };

  let profile;
  try {
    if (existing) {
      const before = {
        businessDescription: existing.businessDescription,
        targetAudience: existing.targetAudience,
        toneOfVoice: existing.toneOfVoice,
        siteUrl: existing.siteUrl,
        cmsType: existing.cmsType,
      };
      profile = await prisma.$transaction(async (tx) => {
        const updated = await tx.seoProfile.update({
          where: { id: existing.id },
          data: {
            businessDescription: fields.businessDescription ?? existing.businessDescription,
            targetAudience: fields.targetAudience ?? existing.targetAudience,
            toneOfVoice: fields.toneOfVoice ?? existing.toneOfVoice,
            siteUrl: fields.siteUrl ?? existing.siteUrl,
            cmsType: fields.cmsType ?? existing.cmsType,
          },
        });
        await tx.seoProfileAudit.create({
          data: {
            profileId: updated.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'business_info_updated',
            before,
            after: {
              businessDescription: updated.businessDescription,
              targetAudience: updated.targetAudience,
              toneOfVoice: updated.toneOfVoice,
              siteUrl: updated.siteUrl,
              cmsType: updated.cmsType,
            },
            actorType: 'client',
            actorEmail: `client:${resolved.clientId}`,
          },
        });
        return updated;
      });
    } else {
      profile = await prisma.$transaction(async (tx) => {
        const created = await tx.seoProfile.create({
          data: {
            clientId: resolved.clientId,
            clientProductId: clientProduct.id,
            tenantId: clientProduct.tenantId,
            ...fields,
          },
        });
        await tx.seoProfileAudit.create({
          data: {
            profileId: created.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'created',
            before: Prisma.JsonNull,
            after: {
              businessDescription: created.businessDescription,
              targetAudience: created.targetAudience,
              toneOfVoice: created.toneOfVoice,
              siteUrl: created.siteUrl,
              cmsType: created.cmsType,
            },
            actorType: 'client',
            actorEmail: `client:${resolved.clientId}`,
          },
        });
        return created;
      });
    }
  } catch (err) {
    logError('seo_profile.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    profile: {
      businessDescription: profile.businessDescription,
      targetAudience: profile.targetAudience,
      toneOfVoice: profile.toneOfVoice,
      siteUrl: profile.siteUrl,
      cmsType: profile.cmsType,
    },
  });
}
