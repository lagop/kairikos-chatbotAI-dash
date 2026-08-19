import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { decryptMetaToken } from '@/lib/meta-business';
import { sendMessage } from '@/lib/messenger-api';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/messenger/send
//
// Mirror of .../whatsapp/send — the only place the Meta access token is
// decrypted after connect time, and it never leaves this server.
// =============================================================================

const BodySchema = z.object({
  pageId: z.string().trim().min(1),
  recipientId: z.string().trim().min(1),
  text: z.string().trim().min(1).max(4000),
});

export async function POST(req: NextRequest) {
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

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { channel: 'messenger', externalId: body.data.pageId },
  });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const token = decryptMetaToken({
    ciphertext: connection.accessTokenCiphertext,
    iv: connection.accessTokenIv,
    tag: connection.accessTokenTag,
  });

  const result = await sendMessage(token, body.data.pageId, body.data.recipientId, body.data.text);
  if (!result.ok) {
    logError('channels.messenger_send.failed', new Error(result.error), { connectionId: connection.id }, 'warn');
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

  return NextResponse.json({ ok: true, messageId: result.data.message_id ?? null });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
