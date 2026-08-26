import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Prospección con IA, Fase B — PATCH /api/internal/leads/[id]/enrich
//
// n8n calls this once it has extracted contact details from the raw
// website text src/lib/prospecting-enrichment.ts sent it (see that
// module's header). Same auth convention as POST /api/internal/leads —
// PORTAL_API_KEY via x-kairikos-internal-key.
//
// Every field is optional and merged onto the existing row (`?? existing.X`,
// same coalesce pattern POST /api/internal/leads uses for its own
// "refresh" branch) — n8n may only have extracted an email, not a phone,
// and must not null out a field it found nothing for. At least one field
// is required so an empty PATCH isn't silently accepted as a no-op that
// still burns a LeadAudit row.
// =============================================================================

const BodySchema = z
  .object({
    contactEmail: z.string().trim().email().max(200).optional(),
    contactPhone: z.string().trim().min(1).max(50).optional(),
    contactName: z.string().trim().min(1).max(200).optional(),
    scoreReason: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'at least one field must be provided',
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

  const existing = await prisma.lead.findUnique({ where: { id: params.id } });
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.lead.update({
      where: { id: existing.id },
      data: {
        contactEmail: data.contactEmail ?? existing.contactEmail,
        contactPhone: data.contactPhone ?? existing.contactPhone,
        contactName: data.contactName ?? existing.contactName,
        scoreReason: data.scoreReason ?? existing.scoreReason,
      },
    });
    await tx.leadAudit.create({
      data: {
        leadId: row.id,
        clientId: row.clientId,
        tenantId: row.tenantId,
        action: 'enriched',
        statusBefore: existing.status,
        statusAfter: existing.status,
        actorId: 'system:n8n',
      },
    });
    return row;
  });

  return NextResponse.json({ ok: true, leadId: updated.id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
