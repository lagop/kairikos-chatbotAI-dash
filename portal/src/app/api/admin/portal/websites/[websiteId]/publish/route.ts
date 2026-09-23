import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { publishWebsite } from '@/lib/website-publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Subir dos archivos por SFTP a un alojamiento compartido lento puede pasar
// de los 10 segundos por defecto de Vercel/Next. El cliente SFTP ya corta a
// los 20 s por su cuenta.
export const maxDuration = 60;

/**
 * POST /api/admin/portal/websites/[websiteId]/publish
 *
 * Publica el sitio en el alojamiento del cliente. Sin TOTP: la credencial ya
 * está guardada (eso sí lo pidió) y publicar es la acción del día a día —
 * pedir el segundo factor cada vez que se corrige una errata acabaría con el
 * operador apuntándose el código en un papel.
 *
 * Idempotente: sube los mismos archivos encima. Se puede pulsar dos veces
 * sin romper nada.
 */
export async function POST(req: NextRequest, { params }: { params: { websiteId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const operator =
    auth.operatorId === 'legacy'
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

  const result = await publishWebsite(prisma, params.websiteId, {
    type: 'operator',
    operatorId: auth.operatorId === 'legacy' ? null : auth.operatorId,
    email: operator?.email ?? null,
  });

  if (!result.ok) {
    // Los tres casos se distinguen porque el remedio es distinto: falta la
    // credencial (pegar una), no existe el sitio (recargar), o falló la
    // subida (el mensaje del servidor del cliente, que es lo único útil).
    const status =
      result.error === 'website_not_found' ? 404 : result.error === 'credential_missing' ? 409 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, filesUploaded: result.filesUploaded });
}
