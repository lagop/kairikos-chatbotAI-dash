import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { fetchAccessibleProperties, getValidAccessToken } from '@/lib/google-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// SEO con IA — POST /api/portal/seo/analytics/select-property
//
// Completes the connection the OAuth callback left in
// 'pending_property_selection'. Re-fetches the live property list
// server-side and only accepts a propertyId that's actually IN it —
// never trusts the client-submitted displayName, and never accepts a
// propertyId the connected Google account doesn't actually have access
// to (the request body could otherwise be hand-crafted to claim any
// property).
// =============================================================================

const BodySchema = z.object({ propertyId: z.string().trim().min(1).max(100) });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database' || !isDatabaseConfigured) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.googleAnalyticsConnection.findUnique({
    where: { clientId: resolved.clientId },
    select: { id: true, status: true, refreshTokenCiphertext: true, refreshTokenIv: true, refreshTokenTag: true },
  });
  if (!connection || connection.status !== 'pending_property_selection') {
    return NextResponse.json({ error: 'not_pending_selection' }, { status: 409 });
  }

  const accessToken = await getValidAccessToken(connection);
  if (!accessToken) {
    return NextResponse.json({ error: 'token_invalid' }, { status: 502 });
  }

  const properties = await fetchAccessibleProperties(accessToken);
  const match = properties.find((p) => p.propertyId === body.data.propertyId);
  if (!match) {
    return NextResponse.json({ error: 'property_not_accessible' }, { status: 400 });
  }

  await prisma.googleAnalyticsConnection.update({
    where: { id: connection.id },
    data: { propertyId: match.propertyId, propertyDisplayName: match.displayName, status: 'active' },
  });

  return NextResponse.json({ ok: true, propertyId: match.propertyId, propertyDisplayName: match.displayName });
}
