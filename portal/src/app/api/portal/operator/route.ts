import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  resolveOperatorRecipients,
  sendOperatorNotification,
  utcDayKey,
} from '@/lib/operator-notify';

const OPERATOR_COOKIE = 'kairikos-portal-operator';
const HELP_REQUEST_KIND = 'help-request';

export async function POST(req: NextRequest) {
  // Two payloads share this route:
  //   1. Form-encoded `{ mode: 'enable' | 'disable', return_to: string }`
  //      — operator-view toggle for `/admin/portal/*` (KAIA-755).
  //   2. JSON `{ kind: 'help-request', subject, message }` — KAIA-1062
  //      "I need help" button on the client portal. Emails the
  //      operator and dedupes via the `OperatorNotification` table.
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return handleHelpRequest(req);
  }
  return handleOperatorViewToggle(req);
}

async function handleOperatorViewToggle(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const mode = String(form.get('mode') ?? '');
  const target = String(form.get('return_to') ?? '/admin/portal/clients');
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  if (mode === 'enable') {
    res.cookies.set(OPERATOR_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
  } else if (mode === 'disable') {
    res.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
  }
  return res;
}

interface HelpRequestPayload {
  kind?: unknown;
  subject?: unknown;
  message?: unknown;
}

async function handleHelpRequest(req: NextRequest): Promise<NextResponse> {
  let body: HelpRequestPayload = {};
  try {
    body = (await req.json()) as HelpRequestPayload;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  if (body?.kind !== HELP_REQUEST_KIND) {
    return NextResponse.json(
      { error: 'bad_request', detail: `kind must be "${HELP_REQUEST_KIND}"` },
      { status: 400 },
    );
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (subject.length < 3 || subject.length > 200) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'subject must be 3–200 chars' },
      { status: 400 },
    );
  }
  if (message.length < 10 || message.length > 4000) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'message must be 10–4000 chars' },
      { status: 400 },
    );
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json(
      { ok: true, deduped: false, mocked: true, kind: HELP_REQUEST_KIND },
      { status: 200 },
    );
  }

  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);
  if (recipients.length === 0) {
    return NextResponse.json(
      {
        error: 'operator_not_configured',
        detail: 'KAIRIKOS_OPERATOR_EMAILS is not set',
      },
      { status: 500 },
    );
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { id: true, name: true, companyName: true },
  });
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const clientDisplayName = client.companyName ?? client.name;

  // Dedup: the (clientId, kind, day) unique constraint makes a repeat
  // help-request from the same client on the same UTC day a no-op.
  // Help requests are time-sensitive and small in volume, so the
  // per-day cap matches the operator-notify dedup policy from KAIA-1061.
  const day = utcDayKey();
  const existing = await prisma.operatorNotification.findUnique({
    where: {
      clientId_kind_day: {
        clientId: client.id,
        kind: HELP_REQUEST_KIND,
        day,
      },
    },
    select: { id: true, sentAt: true, resendMessageId: true },
  });
  if (existing) {
    return NextResponse.json({
      ok: true,
      deduped: true,
      kind: HELP_REQUEST_KIND,
      clientId: client.id,
      day,
      sentAt: existing.sentAt.toISOString(),
      resendMessageId: existing.resendMessageId,
    });
  }

  const fullSubject = `[Kairikos] Ayuda solicitada: ${clientDisplayName} — ${subject}`;
  const text = [
    'Hola,',
    '',
    `El cliente "${clientDisplayName}" (${client.id}) ha solicitado ayuda desde el portal.`,
    '',
    `Asunto: ${subject}`,
    '',
    'Mensaje:',
    message,
    '',
    '— Kairikos Portal',
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Portal</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">Ayuda solicitada por el cliente</h1>
    </div>
    <p>El cliente <strong>${escapeHtml(clientDisplayName)}</strong> (${escapeHtml(client.id)}) ha solicitado ayuda desde el portal.</p>
    <p><strong>Asunto:</strong> ${escapeHtml(subject)}</p>
    <pre style="background: #f3f4f6; padding: 12px; border-radius: 6px; font-size: 13px; overflow: auto; white-space: pre-wrap; word-break: break-word;">${escapeHtml(message)}</pre>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">Esta alerta la envía el portal automáticamente cuando un cliente pulsa "Necesito ayuda".</p>
  </body>
</html>`;

  const sent = await sendOperatorNotification({
    // @ts-expect-error WP-01/WP-11 — 'help-request' isn't in NotificationKind
    // yet; WP-11 adds it to the union and to ALLOWED_KINDS.
    kind: HELP_REQUEST_KIND,
    to: recipients,
    subject: fullSubject,
    text,
    html,
  });
  if (!sent.ok) {
    return NextResponse.json(
      { error: 'resend_send_failed', detail: sent.error },
      { status: 502 },
    );
  }

  const row = await prisma.operatorNotification.upsert({
    where: {
      clientId_kind_day: {
        clientId: client.id,
        kind: HELP_REQUEST_KIND,
        day,
      },
    },
    create: {
      clientId: client.id,
      kind: HELP_REQUEST_KIND,
      day,
      subject: fullSubject,
      context: JSON.stringify({ subject, message }),
      resendMessageId: sent.messageId,
      sentAt: new Date(),
    },
    update: {
      subject: fullSubject,
      context: JSON.stringify({ subject, message }),
      sentAt: new Date(),
    },
    select: { id: true, sentAt: true, resendMessageId: true },
  });

  return NextResponse.json({
    ok: true,
    deduped: false,
    id: row.id,
    kind: HELP_REQUEST_KIND,
    clientId: client.id,
    day,
    sentAt: row.sentAt.toISOString(),
    resendMessageId: row.resendMessageId,
    skipped: 'skipped' in sent ? sent.skipped : undefined,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
