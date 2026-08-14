import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { webBriefSchema, webBriefDraftSchema } from '@/lib/web-brief-schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/web-brief
 *
 * Single upsert endpoint for the 'web' product's standalone intake form
 * (see prisma/schema.prisma's WebBrief model comment — deliberately not
 * built on the chatbot wizard engine). `submit: true` validates against
 * the full schema (businessName/goal/pagesNeeded required) and stamps
 * `submittedAt`; `submit: false` saves whatever partial shape is valid
 * as a draft, no required fields. Resubmitting after 'submitted' is
 * allowed — this route never locks the row, the portal UI just chooses
 * whether to show the form or a summary based on `status`.
 *
 * 401 { error: 'unauthorized' }
 * 404 { error: 'not_contracted' } — client doesn't have 'web' active
 * 400 { error: 'invalid_body', details }
 * 503 { error: 'service_unavailable' }
 * 200 { status: 'draft' | 'submitted' }
 */
export async function POST(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasWeb = await isProductContracted(prisma, resolved.clientId, 'web');
  if (!hasWeb) {
    return NextResponse.json({ error: 'not_contracted' }, { status: 404 });
  }

  const rawBody = await req.json().catch(() => null);
  const isSubmit = rawBody && typeof rawBody === 'object' && (rawBody as { submit?: unknown }).submit === true;
  const parsed = isSubmit ? webBriefSchema.safeParse(rawBody) : webBriefDraftSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }
  const { submit, ...fields } = parsed.data;

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });

  const now = new Date();
  await prisma.webBrief.upsert({
    where: { clientId: resolved.clientId },
    create: {
      clientId: resolved.clientId,
      tenantId: client?.tenantId ?? null,
      status: submit ? 'submitted' : 'draft',
      ...fields,
      submittedAt: submit ? now : null,
    },
    update: {
      status: submit ? 'submitted' : 'draft',
      ...fields,
      // A draft save never clears a previous submission's timestamp —
      // only a fresh `submit: true` (re)stamps it.
      ...(submit ? { submittedAt: now } : {}),
    },
  });

  return NextResponse.json({ status: submit ? 'submitted' : 'draft' }, { status: 200 });
}
