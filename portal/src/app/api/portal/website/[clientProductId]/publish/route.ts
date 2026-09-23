import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { publishWebsite } from '@/lib/website-publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/portal/website/[clientProductId]/publish
 *
 * El cliente publica sus propios cambios. Puede, y debe: si cada corrección
 * de un horario tuviera que pasar por nosotros, el producto se convierte en
 * una agencia y deja de escalar.
 *
 * Lo que NO puede es tocar la credencial de SFTP con la que se sube: es del
 * operador, está cifrada y no se selecciona desde aquí. Publicar usa la que
 * haya guardada, o falla diciendo que falta.
 */
export async function POST(_req: NextRequest, { params }: { params: { clientProductId: string } }) {
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // El clientId sale de la sesión y se cruza con el clientProductId de la
  // URL: sin ese cruce, cambiar un id en la barra publicaría la web de otro.
  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
    select: { id: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await publishWebsite(prisma, website.id, {
    type: 'client',
    email: `client:${resolved.clientId}`,
  });

  if (!result.ok) {
    const status = result.error === 'credential_missing' ? 409 : 502;
    // Al cliente no se le enseña el error crudo del servidor SFTP: no puede
    // hacer nada con "Permission denied" y le asusta. Se le dice que lo
    // estamos mirando, y el detalle queda en la fila y en la auditoría para
    // el operador.
    const message = result.error === 'credential_missing' ? 'publish_not_configured' : 'publish_failed';
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ ok: true });
}
