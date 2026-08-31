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

const TOOL_KEY = 'google_business';
const DISPLAY_NAME = 'Google Business (Reseñas/Recall)';

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
 * POST /api/admin/portal/settings/integrations/google-business
 *
 * Saves (or rotates) the OAuth client pair Google issues for the
 * Business Profile consent screen (GOOGLE_BUSINESS_OAUTH_CLIENT_ID/
 * SECRET's DB-backed replacement — see lib/google-business.ts's
 * resolveClientCredentials()). No TOTP step-up and no live verification
 * against Google, same reasoning as the google-places route: this isn't
 * a payment credential, and there's no cheap Google endpoint to ping
 * that would validate an OAuth client pair without a real consent flow.
 * A wrong value surfaces the normal way — the first client who tries to
 * connect gets Google's own "invalid_client" error.
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
