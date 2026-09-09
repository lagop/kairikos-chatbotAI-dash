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
// "Sistema IA de captación" — PATCH /api/portal/leads/qualification
//
// Client self-serve, same posture as PATCH /api/portal/prospecting/campaign:
// no technical complexity here that would justify operator intermediation,
// and this is the single piece of context lib/lead-classification-ai.ts's
// classifier needs to score leads against THIS client's reality instead of
// generically. Deliberately NOT the chatbot wizard engine — see
// LeadQualificationProfile's schema comment for why.
//
// Fase 6 — the row itself is normally already there by the time this
// runs: ensureLeadQualificationProfile (product-onboarding.ts) creates
// it empty at purchase time. The lazy `create` below stays as the
// fallback for a row that predates that hook, or the rare case where the
// hook's own write failed silently — this PATCH must keep working
// either way.
// =============================================================================

const BodySchema = z
  .object({
    perfilClienteIdeal: z.string().trim().min(1).max(2000).optional(),
    senalesDescarte: z.string().trim().max(2000).optional(),
    emailAviso: z.preprocess(
      (v) => (v === '' || v == null ? undefined : String(v).trim()),
      z.string().email().max(200).optional(),
    ),
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
    where: { clientId: resolved.clientId, status: 'active', product: { code: 'leads' } },
    select: { id: true, tenantId: true },
  });
  if (!clientProduct) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const existing = await prisma.leadQualificationProfile.findUnique({
    where: { clientProductId: clientProduct.id },
    select: { id: true, perfilClienteIdeal: true, senalesDescarte: true, emailAviso: true },
  });

  const actorEmail = `client:${resolved.clientId}`;

  let profile;
  try {
    if (existing) {
      const before = {
        perfilClienteIdeal: existing.perfilClienteIdeal,
        senalesDescarte: existing.senalesDescarte,
        emailAviso: existing.emailAviso,
      };
      profile = await prisma.$transaction(async (tx) => {
        const updated = await tx.leadQualificationProfile.update({
          where: { id: existing.id },
          data: {
            perfilClienteIdeal: body.data.perfilClienteIdeal ?? existing.perfilClienteIdeal,
            senalesDescarte: body.data.senalesDescarte ?? existing.senalesDescarte,
            emailAviso: body.data.emailAviso ?? existing.emailAviso,
          },
        });
        await tx.leadQualificationProfileAudit.create({
          data: {
            profileId: updated.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'updated',
            before,
            after: {
              perfilClienteIdeal: updated.perfilClienteIdeal,
              senalesDescarte: updated.senalesDescarte,
              emailAviso: updated.emailAviso,
            },
            actorEmail,
          },
        });
        return updated;
      });
    } else {
      profile = await prisma.$transaction(async (tx) => {
        const created = await tx.leadQualificationProfile.create({
          data: {
            clientId: resolved.clientId,
            clientProductId: clientProduct.id,
            tenantId: clientProduct.tenantId,
            perfilClienteIdeal: body.data.perfilClienteIdeal ?? null,
            senalesDescarte: body.data.senalesDescarte ?? null,
            emailAviso: body.data.emailAviso ?? null,
          },
        });
        await tx.leadQualificationProfileAudit.create({
          data: {
            profileId: created.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'created',
            before: Prisma.JsonNull,
            after: {
              perfilClienteIdeal: created.perfilClienteIdeal,
              senalesDescarte: created.senalesDescarte,
              emailAviso: created.emailAviso,
            },
            actorEmail,
          },
        });
        return created;
      });
    }
  } catch (err) {
    logError('lead_qualification_profile.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    profile: {
      perfilClienteIdeal: profile.perfilClienteIdeal,
      senalesDescarte: profile.senalesDescarte,
      emailAviso: profile.emailAviso,
    },
  });
}
