import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveReviewConnection } from '@/lib/review-locations';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { hasGoogleBusinessConnectAccess } from '@/lib/google-business';
import {
  createCampaignWithRequests,
  isConsentBasis,
  MAX_RECIPIENTS_PER_CAMPAIGN,
} from '@/lib/review-request-campaign';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RecipientSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().max(200).optional(),
});

const BodySchema = z.object({
  // Fase 3 — a qué local pide reseñas esta campaña. Opcional: con un solo
  // local se resuelve el suyo.
  connectionId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  consentBasis: z.string().refine(isConsentBasis, { message: 'invalid consentBasis' }),
  recipients: z.array(RecipientSchema).min(1).max(MAX_RECIPIENTS_PER_CAMPAIGN),
});

/**
 * WP-22b — GET/POST /api/portal/google-business/campaigns
 *
 * POST creates a campaign and sends the same invitation to every
 * recipient in the request — there is no per-recipient branching
 * anywhere in this route (the AC's "misma invitación a todos por
 * igual"). Capped at MAX_RECIPIENTS_PER_CAMPAIGN because sending happens
 * synchronously within the request.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  // Fase 3 — una campaña pide reseñas PARA UN LOCAL: su enlace de reseña
  // (reviewUrl) es el de esa ubicación concreta, así que mandar el del
  // local equivocado manda a los clientes a valorar otra tienda.
  const connection = await resolveReviewConnection(prisma, resolved.clientId, body.data.connectionId);
  if (!connection) {
    return NextResponse.json({ error: body.data.connectionId ? 'not_connected' : 'location_required' }, { status: 404 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { companyName: true, name: true },
  });
  const businessName = client?.companyName ?? client?.name ?? 'Nuestro negocio';

  const result = await createCampaignWithRequests({
    connection,
    businessName,
    campaignName: body.data.name,
    consentBasis: body.data.consentBasis,
    recipients: body.data.recipients.map((r) => ({ recipient: r.email, name: r.name ?? null })),
  });

  if (!result.ok) {
    const status = result.error === 'no_review_url' ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result, { status: 201 });
}

export async function GET() {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') return NextResponse.json([]);

  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const campaigns = await prisma.reviewRequestCampaign.findMany({
    where: { clientId: resolved.clientId },
    orderBy: { createdAt: 'desc' },
    include: { requests: { select: { status: true, clickedAt: true } } },
  });

  return NextResponse.json(
    campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      totalRequests: c.requests.length,
      sent: c.requests.filter((r) => r.status === 'sent').length,
      failed: c.requests.filter((r) => r.status === 'failed').length,
      clicked: c.requests.filter((r) => r.clickedAt !== null).length,
    })),
  );
}
