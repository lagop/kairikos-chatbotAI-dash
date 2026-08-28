import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { encryptWordPressAppPassword } from '@/lib/seo';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA, Fase A — PATCH /api/admin/portal/seo/[clientId]/technical-setup
//
// The operator's half of SeoProfile's column-segmented onboarding (see the
// model's schema comment): the WordPress publish access a non-technical
// client can't set up alone. Never touches the client's own fields
// (business context, siteUrl, cmsType) — those are PATCH
// /api/portal/seo/profile's job.
//
// Requires an existing SeoProfile — the client has to have started
// onboarding first; there is nothing to complement yet otherwise.
//
// Also carries contentGenerationMinIntervalDaysOverride — not a
// WordPress field, but still an operator-only, per-client setting on
// this same row, so it rides the same PATCH rather than a new route.
// =============================================================================

const BodySchema = z
  .object({
    wordpressUrl: z.string().trim().url().max(500).optional(),
    wordpressUsername: z.string().trim().min(1).max(200).optional(),
    wordpressAppPassword: z.string().trim().min(1).max(500).optional(),
    technicalSetupNotes: z.string().trim().max(2000).optional(),
    // Per-client override of SeoSettings' global content-generation
    // cadence — see the field's own schema comment. `null` explicitly
    // CLEARS the override (reverts to the global default); `undefined`
    // (the field simply absent from the body) leaves it untouched —
    // unlike every other field above, which only ever gets set, this one
    // needs a real way to be un-set again.
    contentGenerationMinIntervalDaysOverride: z.number().int().min(1).max(90).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'at least one field must be provided',
  });

export async function PATCH(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.seoProfile.findFirst({
    where: { clientId: params.clientId },
    select: {
      id: true,
      tenantId: true,
      wordpressUrl: true,
      wordpressUsername: true,
      wordpressAppPasswordCiphertext: true,
      technicalSetupNotes: true,
      technicalSetupCompletedAt: true,
      contentGenerationMinIntervalDaysOverride: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: 'not_found', detail: 'el cliente aun no ha empezado el onboarding' }, { status: 404 });
  }

  // 'legacy' is the placeholder id authenticateAdminRequest returns for
  // the KAIA_OPERATOR_API_KEY header path — not a real Operator row.
  // Looking it up would throw (Operator.id is @db.Uuid). Same fix as the
  // Google Places integrations route.
  const isLegacyAuth = auth.operatorId === 'legacy';
  const operator = isLegacyAuth
    ? null
    : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  const actorOperatorId = isLegacyAuth ? null : auth.operatorId;
  const actorEmail = operator?.email ?? null;

  const nextWordpressUrl = body.data.wordpressUrl ?? existing.wordpressUrl;
  const nextWordpressUsername = body.data.wordpressUsername ?? existing.wordpressUsername;
  const hasNewPassword = body.data.wordpressAppPassword !== undefined;
  const hasExistingPassword = existing.wordpressAppPasswordCiphertext !== null;
  const nextHasPassword = hasNewPassword || hasExistingPassword;

  const before = {
    wordpressUrl: existing.wordpressUrl,
    wordpressUsername: existing.wordpressUsername,
    hasAppPassword: hasExistingPassword,
    technicalSetupNotes: existing.technicalSetupNotes,
    contentGenerationMinIntervalDaysOverride: existing.contentGenerationMinIntervalDaysOverride,
  };

  const encrypted = hasNewPassword ? encryptWordPressAppPassword(body.data.wordpressAppPassword as string) : null;

  // Stamped once, the first time both the URL and the app password are on
  // file — never re-stamped on a later edit that leaves both still present.
  const justCompleted =
    !existing.technicalSetupCompletedAt && Boolean(nextWordpressUrl) && nextHasPassword;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.seoProfile.update({
        where: { id: existing.id },
        data: {
          wordpressUrl: nextWordpressUrl,
          wordpressUsername: nextWordpressUsername,
          ...(encrypted
            ? {
                wordpressAppPasswordCiphertext: encrypted.ciphertext,
                wordpressAppPasswordIv: encrypted.iv,
                wordpressAppPasswordTag: encrypted.tag,
              }
            : {}),
          technicalSetupNotes: body.data.technicalSetupNotes ?? existing.technicalSetupNotes,
          ...(justCompleted ? { technicalSetupCompletedAt: new Date() } : {}),
          ...(body.data.contentGenerationMinIntervalDaysOverride !== undefined
            ? { contentGenerationMinIntervalDaysOverride: body.data.contentGenerationMinIntervalDaysOverride }
            : {}),
        },
      });
      await tx.seoProfileAudit.create({
        data: {
          profileId: row.id,
          clientId: params.clientId,
          tenantId: existing.tenantId,
          action: 'technical_setup_updated',
          before,
          after: {
            wordpressUrl: row.wordpressUrl,
            wordpressUsername: row.wordpressUsername,
            hasAppPassword: nextHasPassword,
            technicalSetupNotes: row.technicalSetupNotes,
            contentGenerationMinIntervalDaysOverride: row.contentGenerationMinIntervalDaysOverride,
          },
          actorType: 'operator',
          actorOperatorId,
          actorEmail,
        },
      });
      return row;
    });

    return NextResponse.json({
      ok: true,
      profile: {
        wordpressUrl: updated.wordpressUrl,
        wordpressUsername: updated.wordpressUsername,
        hasAppPassword: nextHasPassword,
        technicalSetupNotes: updated.technicalSetupNotes,
        technicalSetupCompletedAt: updated.technicalSetupCompletedAt?.toISOString() ?? null,
        contentGenerationMinIntervalDaysOverride: updated.contentGenerationMinIntervalDaysOverride,
      },
    });
  } catch (err) {
    logError('seo_profile.technical_setup_failed', err, { clientId: params.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
