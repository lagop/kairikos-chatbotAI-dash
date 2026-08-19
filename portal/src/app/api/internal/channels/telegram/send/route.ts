import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import { decryptChannelCredential } from '@/lib/channel-crypto';
import { sendMessage } from '@/lib/telegram-api';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales — POST /api/internal/channels/telegram/send
//
// The ONLY place the Telegram bot token is decrypted after connect
// time, and it never leaves this server: n8n asks the portal to send
// the reply on its behalf instead of receiving the token itself. This
// is a deliberate departure from the "portal hands off credentials, n8n
// does platform-specific activation" framing in the original Canales
// plan — that framing assumed n8n would need the raw secret to operate
// the channel; in practice there is no reason to ever let it leave the
// portal, since every Telegram API call (setWebhook, deleteWebhook,
// sendMessage) can be proxied from here.
// =============================================================================

const BodySchema = z.object({
  connectionId: z.string().trim().min(1),
  chatId: z.union([z.string(), z.number()]),
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

  const connection = await prisma.telegramConnection.findUnique({ where: { id: body.data.connectionId } });
  if (!connection) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status !== 'active') {
    return NextResponse.json({ error: 'disabled' }, { status: 403 });
  }

  const token = decryptChannelCredential({
    ciphertext: connection.botTokenCiphertext,
    iv: connection.botTokenIv,
    tag: connection.botTokenTag,
  });

  const result = await sendMessage(token, body.data.chatId, body.data.text);
  if (!result.ok) {
    logError('channels.telegram_send.failed', new Error(result.error), { connectionId: connection.id }, 'warn');
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

  return NextResponse.json({ ok: true, messageId: result.data.message_id });
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}
