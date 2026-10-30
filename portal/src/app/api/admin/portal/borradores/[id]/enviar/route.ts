import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { releasePublicDraft } from '@/lib/public-draft-delivery';
import { isUuid } from '@/lib/web-draft-edit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 30/10/2026 — POST /api/admin/portal/borradores/[id]/enviar
 *
 * «Enviar ahora»: el operador ya lo ha revisado y no hace falta esperar al
 * plazo. Abre su enlace y le manda el correo (lib/public-draft-delivery.ts).
 * Si ya se envió pero el correo falló, lo reintenta. Sin TOTP: no toca dinero.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!isUuid(params.id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await releasePublicDraft(prisma, params.id, { retryFailed: true });
  return NextResponse.json({ ok: result === 'sent' || result === 'sent_no_email', result });
}
