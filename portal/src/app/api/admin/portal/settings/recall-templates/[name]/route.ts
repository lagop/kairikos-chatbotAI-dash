import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { validateTemplateBody } from '@/lib/recall-templates';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  bodyText: z.string().trim().min(1),
  bodyExamples: z.array(z.string()),
});

/**
 * PATCH /api/admin/portal/settings/recall-templates/[name]
 *
 * Edits ONLY bodyText/bodyExamples for one of the 7 recall templates —
 * name/languageCode/category stay fixed (see recall-templates.ts's
 * header for why renaming here would silently desync submission from
 * sending). Requires a fresh TOTP step-up: unlike a credential, a wrong
 * edit here doesn't leak a secret, but it can permanently break every
 * WhatsApp send for every new client until fixed (Meta error 132000,
 * not retryable) — same severity class as the account-credential routes,
 * different failure mode. validateTemplateBody enforces the {{n}}
 * placeholder contract server-side before this can ever reach the DB.
 *
 * Does NOT resubmit to Meta and does NOT touch any client's
 * already-approved template on their WABA — this only changes what gets
 * submitted to clients who connect AFTER the edit. That limitation is
 * surfaced in the settings UI, not just here.
 */
export async function PATCH(req: NextRequest, { params }: { params: { name: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { bodyText, bodyExamples } = body.data;

  const validation = validateTemplateBody(bodyText, bodyExamples);
  if (!validation.ok) {
    return NextResponse.json({ error: 'invalid_placeholders', detail: validation.error }, { status: 400 });
  }

  const existing = await prisma.recallTemplateDefinition.findUnique({ where: { name: params.name } });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.recallTemplateDefinition.update({
        where: { name: params.name },
        data: {
          bodyText,
          bodyExamples,
          updatedByOperatorId: stepUp.operatorId,
          updatedByEmail: operator?.email ?? null,
        },
      });
      await tx.recallTemplateDefinitionAudit.create({
        data: {
          templateName: params.name,
          before: { bodyText: existing.bodyText, bodyExamples: existing.bodyExamples },
          after: { bodyText, bodyExamples },
          actorOperatorId: stepUp.operatorId,
          actorEmail: operator?.email ?? null,
        },
      });
      return row;
    });

    return NextResponse.json({
      ok: true,
      name: updated.name,
      bodyText: updated.bodyText,
      bodyExamples: updated.bodyExamples,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByEmail: updated.updatedByEmail,
    });
  } catch (err) {
    logError('recall_templates.update_failed', err, { name: params.name });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
