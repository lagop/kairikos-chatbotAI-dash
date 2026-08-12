// KAIA-2103 — Admin: trigger a setup-password email for a client user.
// Sends an email with a direct link to set the initial password (no token needed,
// the email itself is the auth signal — sent to a known, approved address).
//
// KAIA-13282 — refactored to share the canonical sendSetupPassword helper
// in src/lib/auth-email.ts with the new PATCH /api/admin/portal/clients/[id]
// path that fires on email change.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { sendSetupPassword } from '@/lib/auth-email';

const SendSetupEmailSchema = z.object({
  email: z.string().email(),
});

const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const clientId = params.id;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const parsed = SendSetupEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const { email } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const clientUser = await prisma.chatbotClientUser.findFirst({
    where: { nextAuthEmail: normalizedEmail, clientId },
    select: { id: true, userId: true },
  });

  if (!clientUser) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const user = clientUser.userId
    ? await prisma.user.findUnique({
        where: { id: clientUser.userId },
        select: { id: true, passwordHash: true },
      })
    : null;

  if (!user || user.passwordHash !== null) {
    return NextResponse.json({ error: 'password_already_set' }, { status: 409 });
  }

  const setupUrl = `${PORTAL_BASE_URL}/portal/setup-password?email=${encodeURIComponent(normalizedEmail)}`;

  try {
    await sendSetupPassword({ to: normalizedEmail, setupUrl });
  } catch (err) {
    console.error('[send-setup-email] email send failed:', err);
    return NextResponse.json({ error: 'email_send_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
