import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { publishDraftToWordPress, hasWordPressCredentials } from '@/lib/wordpress-publish';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

// =============================================================================
// SEO con IA, Fase C — PATCH /api/admin/portal/seo/[clientId]/content-drafts/[draftId]
//
// The operator's approve/reject decision on an AI-drafted article, plus
// the publish step: approving a draft attempts to publish it to
// WordPress IMMEDIATELY, synchronously, in the same request — a single
// REST call, not a slow batch job, so there's no reason to defer it to
// a cron (unlike content GENERATION, which goes through n8n because
// that step needs an LLM). A publish failure (missing WP creds, the
// site unreachable, WordPress rejecting the request) does not fail the
// approval itself — the draft is still marked 'approved', just with
// status flipped again to 'publish_failed' and the reason recorded, so
// the operator can fix the underlying issue (e.g. finish the Fase A
// technical setup) and retry via `action: 'retry_publish'`.
//
// The client never sees or approves a draft — operator-only, same
// authenticateAdminRequest + isLegacyAuth guard as every other new
// operator route this session (audit route, technical-setup route).
// =============================================================================

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), rejectionReason: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal('retry_publish') }),
]);

async function attemptPublish(draftId: string, clientId: string) {
  const draft = await prisma.seoContentDraft.findUnique({
    where: { id: draftId },
    select: { id: true, profileId: true, title: true, bodyHtml: true, metaDescription: true },
  });
  if (!draft || !draft.title || !draft.bodyHtml) {
    return { ok: false as const, error: 'draft_incomplete' };
  }

  const profile = await prisma.seoProfile.findUnique({
    where: { id: draft.profileId },
    select: {
      wordpressUrl: true,
      wordpressUsername: true,
      wordpressAppPasswordCiphertext: true,
      wordpressAppPasswordIv: true,
      wordpressAppPasswordTag: true,
    },
  });

  if (!hasWordPressCredentials(profile)) {
    await prisma.seoContentDraft.update({
      where: { id: draftId },
      data: { status: 'publish_failed', publishError: 'missing_wordpress_credentials' },
    });
    return { ok: false as const, error: 'missing_wordpress_credentials' };
  }

  const result = await publishDraftToWordPress(profile, {
    title: draft.title,
    bodyHtml: draft.bodyHtml,
    metaDescription: draft.metaDescription,
  });

  if (result.ok) {
    await prisma.seoContentDraft.update({
      where: { id: draftId },
      data: {
        status: 'published',
        publishedAt: new Date(),
        wordpressPostId: result.postId,
        wordpressPostUrl: result.postUrl,
        publishError: null,
      },
    });
    return { ok: true as const };
  }

  logError('seo_content_review.publish_failed', new Error(result.error), { clientId, draftId }, 'warn');
  await prisma.seoContentDraft.update({
    where: { id: draftId },
    data: { status: 'publish_failed', publishError: result.error.slice(0, 500) },
  });
  return { ok: false as const, error: result.error };
}

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

  if (body.data.action === 'retry_publish') {
    if (draft.status !== 'publish_failed') {
      return NextResponse.json({ error: 'not_retryable', status: draft.status }, { status: 409 });
    }
    const publishResult = await attemptPublish(draft.id, params.clientId);
    return NextResponse.json({ ok: publishResult.ok, draftId: draft.id, publishError: publishResult.ok ? undefined : publishResult.error });
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
    if (body.data.action === 'reject') {
      const updated = await prisma.seoContentDraft.update({
        where: { id: draft.id },
        data: { status: 'rejected', reviewedBy, reviewedAt: new Date(), rejectionReason: body.data.rejectionReason },
      });
      return NextResponse.json({ ok: true, draftId: updated.id, status: updated.status });
    }

    // action === 'approve'
    await prisma.seoContentDraft.update({
      where: { id: draft.id },
      data: { status: 'approved', reviewedBy, reviewedAt: new Date(), rejectionReason: null },
    });
    const publishResult = await attemptPublish(draft.id, params.clientId);
    const finalStatus = publishResult.ok ? 'published' : 'publish_failed';
    return NextResponse.json({
      ok: true,
      draftId: draft.id,
      status: finalStatus,
      publishError: publishResult.ok ? undefined : publishResult.error,
    });
  } catch (err) {
    logError('seo_content_review.update_failed', err, { clientId: params.clientId, draftId: params.draftId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
