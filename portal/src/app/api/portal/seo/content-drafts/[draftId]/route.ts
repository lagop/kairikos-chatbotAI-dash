import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { publishAfterClientReview, rejectDraftByClient } from '@/lib/seo-content-review';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// =============================================================================
// SEO con IA, Fase 6 — PATCH /api/portal/seo/content-drafts/[draftId]
//
// El segundo aprobador. El operador ya lo revisó (ver la ruta gemela en
// /api/admin/portal/seo/[clientId]/content-drafts/[draftId]) — esta es
// la ÚLTIMA puerta antes de que el artículo salga en vivo en el
// WordPress real del cliente. `clientId` se resuelve de la sesión, no
// del cuerpo de la petición (misma regla de siempre) y se comprueba
// contra el propio draft, no solo contra el producto contratado —
// nunca se acepta un draftId que no pertenezca a este cliente.
// =============================================================================

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), rejectionReason: z.string().trim().min(1).max(1000) }),
]);

export async function PATCH(req: NextRequest, { params }: { params: { draftId: string } }) {
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

  const draft = await prisma.seoContentDraft.findFirst({
    where: { id: params.draftId, clientId: resolved.clientId },
    select: { id: true, status: true },
  });
  if (!draft) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (draft.status !== 'pending_client_review') {
    return NextResponse.json({ error: 'not_reviewable', status: draft.status }, { status: 409 });
  }

  try {
    if (body.data.action === 'reject') {
      await rejectDraftByClient(prisma, {
        draftId: draft.id,
        clientId: resolved.clientId,
        rejectionReason: body.data.rejectionReason,
      });
      return NextResponse.json({ ok: true, draftId: draft.id, status: 'rejected' });
    }

    // action === 'approve'
    const result = await publishAfterClientReview(prisma, {
      draftId: draft.id,
      clientId: resolved.clientId,
      clientReviewedBy: `client:${resolved.clientId}`,
    });
    return NextResponse.json({ ok: true, draftId: draft.id, status: result.status, publishError: result.publishError });
  } catch (err) {
    logError('seo_content_review.client_decision_failed', err, { clientId: resolved.clientId, draftId: params.draftId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
