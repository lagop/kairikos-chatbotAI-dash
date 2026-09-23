import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { rollbackWebsite } from '@/lib/website-publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const BodySchema = z.object({ version: z.number().int().positive() });

/**
 * POST /api/admin/portal/websites/[websiteId]/rollback
 *
 * Vuelve a una versión anterior: restaura su contenido y publica otra vez.
 *
 * Es del operador y no del cliente a propósito. Volver atrás es lo que se
 * hace cuando algo salió mal, normalmente con el cliente al teléfono; darle
 * el botón a él invita a usarlo como "deshacer" y a perder cambios buenos
 * sin querer. Él tiene guardar y publicar, que es lo que necesita a diario.
 */
export async function POST(req: NextRequest, { params }: { params: { websiteId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const operator =
    auth.operatorId === 'legacy'
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

  const result = await rollbackWebsite(prisma, params.websiteId, body.data.version, {
    type: 'operator',
    operatorId: auth.operatorId === 'legacy' ? null : auth.operatorId,
    email: operator?.email ?? null,
  });

  if (!result.ok) {
    const status =
      result.error === 'release_not_found' || result.error === 'website_not_found'
        ? 404
        : result.error === 'credential_missing'
          ? 409
          : 502;
    return NextResponse.json({ error: result.error }, { status });
  }

  // La vuelta atrás crea una versión NUEVA con el contenido viejo, así que se
  // devuelve su número: el historial sigue siendo la lista de lo que estuvo
  // publicado y en qué orden.
  return NextResponse.json({ ok: true, version: result.version });
}
