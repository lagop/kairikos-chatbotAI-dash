import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { fetchAccessibleProperties, getValidAccessToken } from '@/lib/google-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA — GET /api/portal/seo/analytics/properties
 *
 * Fetched by the property-picker UI (client component) once, when it
 * mounts — NOT during SSR of /portal/seo, which would mean a live
 * Google API call on every single page load while a connection sits in
 * 'pending_property_selection'. Only meaningful for a connection in
 * that state; a fully 'active' connection has nothing left to pick.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database' || !isDatabaseConfigured) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
  return NextResponse.json({ properties });
}
