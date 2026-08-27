import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
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
// Lazily creates the SeoProfile row on first save, same reasoning as
// prospecting's own campaign route: no purchase-time provisioning hook
// exists for any product in this codebase, so the first time the client
// fills in the form IS the natural moment to create the row.
// =============================================================================

const BodySchema = z
  .object({
    businessDescription: z.string().trim().min(1).max(2000).optional(),
    targetAudience: z.string().trim().min(1).max(1000).optional(),
    toneOfVoice: z.string().trim().min(1).max(500).optional(),
    siteUrl: z.string().trim().url().max(500).optional(),
    cmsType: z.enum(['wordpress', 'wix', 'squarespace', 'other', 'no_se']).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'at least one field must be provided',
  });

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
    where: { clientId: resolved.clientId, status: 'active', product: { code: 'seo' } },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

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
