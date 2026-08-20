import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { decryptRefreshToken, revokeGoogleToken } from '@/lib/google-business';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ connectionId: z.string().uuid() });

/**
 * WP-21 — POST /api/portal/google-business/disconnect
 *
 * AC: revoking from the portal invalidates the token at Google too, not
 * just the local row. Revocation at Google is attempted but NOT a
 * precondition for the local disconnect to succeed — a transient failure
 * on Google's revoke endpoint must not trap the client in a state where
 * clicking "disconnect" does nothing. `revokedAtGoogle` in the response
 * tells the caller whether both sides actually cleared, so a future UI
 * can surface a caveat ("desconectado en Kairikos; puede que también
 * tengas que revisar los permisos en tu cuenta de Google") instead of
 * silently claiming full success.
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

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.googleBusinessConnection.findUnique({
    where: { id: body.data.connectionId },
  });
  if (!connection || connection.clientId !== resolved.clientId) {
    // Same 404 whether the row doesn't exist or belongs to someone else —
    // never confirm another client's connection id exists.
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status === 'revoked') {
    return NextResponse.json({ revoked: true, revokedAtGoogle: true, alreadyRevoked: true });
  }

  let revokedAtGoogle = false;
  try {
    const refreshToken = decryptRefreshToken({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      tag: connection.refreshTokenTag,
    });
    revokedAtGoogle = await revokeGoogleToken(refreshToken);
  } catch (err) {
    logError('google_business.disconnect_revoke', err, {
      route: 'POST /api/portal/google-business/disconnect',
      clientId: resolved.clientId,
      connectionId: connection.id,
    });
  }

  await prisma.googleBusinessConnection.update({
    where: { id: connection.id },
    data: { status: 'revoked' },
  });

  return NextResponse.json({ revoked: true, revokedAtGoogle });
}
