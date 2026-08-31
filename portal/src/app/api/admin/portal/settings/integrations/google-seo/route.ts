import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getIntegrationCredentialStatus,
  saveIntegrationCredential,
} from '@/lib/integration-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOOL_KEY = 'google_seo';
const DISPLAY_NAME = 'Google Search Console (SEO)';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getIntegrationCredentialStatus(TOOL_KEY);
  return NextResponse.json(status);
}

const BodySchema = z.object({
  clientId: z.string().trim().min(10),
  clientSecret: z.string().trim().min(10),
});

/**
 * POST /api/admin/portal/settings/integrations/google-seo
 *
 * Same posture as the google-business route: the DB-backed replacement
 * for GOOGLE_SEO_OAUTH_CLIENT_ID/SECRET, no step-up, no live verification.
 * See lib/google-search-console.ts's resolveClientCredentials().
 */
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
    await saveIntegrationCredential(
      TOOL_KEY,
      DISPLAY_NAME,
      body.data.clientSecret,
      { operatorId: isLegacyAuth ? null : auth.operatorId, operatorEmail: operator?.email ?? null },
      body.data.clientId,
    );
  } catch (err) {
    logError('integration_credentials.save_failed', err, { toolKey: TOOL_KEY });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, clientId: body.data.clientId, lastFour: body.data.clientSecret.slice(-4) });
}
