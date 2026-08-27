import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA, Fase C — PATCH /api/internal/seo/content-drafts/[id]
//
// n8n calls this once it has drafted an article from the signals
// lib/seo-content-generation.ts sent it. Same auth convention as PATCH
// /api/internal/leads/[id]/enrich — PORTAL_API_KEY via
// x-kairikos-internal-key.
//
// Only fills a draft that is still 'pending_generation' — an operator
// may have already rejected/approved/published this row by the time a
// slow or retried n8n call lands (ChannelWebhookDelivery's retry sweep
// can redeliver the same request), and a late write must never resurrect
// or overwrite a decision that's already been made.
// =============================================================================

const BodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  bodyHtml: z.string().trim().min(1).max(200_000),
  targetKeyword: z.string().trim().min(1).max(200).optional(),
  metaDescription: z.string().trim().min(1).max(500).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request', details: body.error.flatten() }, { status: 400 });
  }
  const data = body.data;

  const existing = await prisma.seoContentDraft.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (existing.status !== 'pending_generation') {
    return NextResponse.json({ error: 'already_resolved', status: existing.status }, { status: 409 });
  }

  const updated = await prisma.seoContentDraft.update({
    where: { id: existing.id },
    data: {
      title: data.title,
      bodyHtml: data.bodyHtml,
      targetKeyword: data.targetKeyword ?? null,
      metaDescription: data.metaDescription ?? null,
      status: 'drafted',
      generatedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, draftId: updated.id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
