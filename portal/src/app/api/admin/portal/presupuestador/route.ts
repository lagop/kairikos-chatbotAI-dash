import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { saveQuoterVersion } from '@/lib/premium-quoter';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 09/11/2026 — POST /api/admin/portal/presupuestador
//
// Guarda una versión nueva de los datos del presupuestador, o vuelve a una
// anterior copiándola como versión nueva. Solo operador y sin TOTP, igual que
// settings/web: no es una credencial, y lo que guarda se valida entero.
// =============================================================================

const BodySchema = z
  .object({
    basedOn: z.number().int().min(0),
    data: z.unknown().optional(),
    restoreVersion: z.number().int().min(1).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((b) => (b.data === undefined) !== (b.restoreVersion === undefined));

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    let data = body.data.data;
    let note = body.data.note ?? null;
    if (body.data.restoreVersion !== undefined) {
      const old = await prisma.premiumQuoterVersion.findUnique({ where: { version: body.data.restoreVersion }, select: { data: true } });
      if (!old) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      data = old.data;
      note = `Vuelta a la versión ${body.data.restoreVersion}`;
    }
    const result = await saveQuoterVersion(prisma, { data, basedOn: body.data.basedOn, operatorEmail: operator?.email ?? null, note });
    if (!result.ok) {
      return NextResponse.json(result, { status: result.error === 'conflict' ? 409 : 400 });
    }
    return NextResponse.json({ ok: true, version: result.version });
  } catch (err) {
    logError('premium_quoter.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
