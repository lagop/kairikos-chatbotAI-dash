import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getContentGenerationMinIntervalDays,
  updateContentGenerationMinIntervalDays,
  MIN_CONTENT_GENERATION_INTERVAL_DAYS,
  MAX_CONTENT_GENERATION_INTERVAL_DAYS,
} from '@/lib/seo-settings';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA — GET/POST /api/admin/portal/settings/seo
//
// Operator-only, same authenticateAdminRequest + isLegacyAuth guard as
// every other new operator route this session. Currently a single
// field (contentGenerationMinIntervalDays) — see SeoSettings' own
// schema comment on why this isn't a generic key-value settings API.
// No TOTP step-up, unlike Stripe's credential routes — this is an
// operational cadence knob, not a secret or a payment credential; the
// worst case of a wrong value is too many or too few articles, not a
// security incident.
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const contentGenerationMinIntervalDays = await getContentGenerationMinIntervalDays();
  return NextResponse.json({ contentGenerationMinIntervalDays });
}

const BodySchema = z.object({
  contentGenerationMinIntervalDays: z.number().int().min(MIN_CONTENT_GENERATION_INTERVAL_DAYS).max(MAX_CONTENT_GENERATION_INTERVAL_DAYS),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  try {
    const isLegacyAuth = auth.operatorId === 'legacy';
    const operator = isLegacyAuth
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    await updateContentGenerationMinIntervalDays(
      body.data.contentGenerationMinIntervalDays,
      operator?.email ?? (isLegacyAuth ? 'legacy_operator' : null),
    );
  } catch (err) {
    logError('seo_settings.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, contentGenerationMinIntervalDays: body.data.contentGenerationMinIntervalDays });
}
