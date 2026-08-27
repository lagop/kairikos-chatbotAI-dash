import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA, Fase C — PATCH /api/admin/portal/seo/[clientId]/content-drafts/[draftId]
//
// The operator's approve/reject decision on an AI-drafted article. The
// client never sees or approves a draft — this is operator-only, same
// authenticateAdminRequest + isLegacyAuth guard as every other new
// operator route this session (audit route, technical-setup route).
//
// Only acts on a draft that is currently 'drafted' — approving/rejecting
// a 'pending_generation' row makes no sense (there's no content yet) and
// re-deciding an already-approved/rejected/published row would silently
// overwrite a real decision or a completed publish.
// =============================================================================

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), rejectionReason: z.string().trim().min(1).max(1000) }),
]);

export async function PATCH(req: NextRequest, { params }: { params: { clientId: string; draftId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }

  const draft = await prisma.seoContentDraft.findFirst({
    where: { id: params.draftId, clientId: params.clientId },
    select: { id: true, status: true },
  });
  if (!draft) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (draft.status !== 'drafted') {
    return NextResponse.json({ error: 'not_reviewable', status: draft.status }, { status: 409 });
  }

  const isLegacyAuth = auth.operatorId === 'legacy';
  const operator = isLegacyAuth
    ? null
    : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  const reviewedBy = operator?.email ?? (isLegacyAuth ? 'legacy_operator' : auth.operatorId);

  try {
    const updated = await prisma.seoContentDraft.update({
      where: { id: draft.id },
      data:
        body.data.action === 'approve'
          ? { status: 'approved', reviewedBy, reviewedAt: new Date(), rejectionReason: null }
          : { status: 'rejected', reviewedBy, reviewedAt: new Date(), rejectionReason: body.data.rejectionReason },
    });
    return NextResponse.json({ ok: true, draftId: updated.id, status: updated.status });
  } catch (err) {
    logError('seo_content_review.update_failed', err, { clientId: params.clientId, draftId: params.draftId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
