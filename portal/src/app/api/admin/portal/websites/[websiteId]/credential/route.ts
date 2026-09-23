import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { savePublishCredential } from '@/lib/website-publish';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  host: z.string().trim().min(3).max(253),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  remotePath: z.string().trim().max(500),
});

/**
 * PUT /api/admin/portal/websites/[websiteId]/credential
 *
 * Guarda (o rota) la credencial de SFTP del alojamiento del cliente.
 *
 * CON TOTP, a diferencia del alta del sitio: esto es la llave del servidor
 * de un tercero. Quien la tenga puede desfigurarle la web. Mismo criterio
 * que la credencial de Stripe, no el de la clave de Google Places —donde lo
 * peor que pasa es gasto no deseado.
 *
 * La contraseña no vuelve nunca: el GET de estado enseña host, usuario y
 * ruta, y si hay contraseña guardada, no cuál.
 */
export async function PUT(req: NextRequest, { params }: { params: { websiteId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const website = await prisma.clientWebsite.findUnique({
    where: { id: params.websiteId },
    select: { id: true, clientId: true, tenantId: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const saved = await savePublishCredential(prisma, website.id, body.data);
    if (!saved.ok) {
      // invalid_host: alguien intentó guardar localhost o una IP privada.
      // No es un error del sistema, es la guarda haciendo su trabajo.
      return NextResponse.json({ error: saved.error }, { status: 422 });
    }

    const operator =
      auth.operatorId === 'legacy'
        ? null
        : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

    await prisma.clientWebsiteAudit.create({
      data: {
        websiteId: website.id,
        clientId: website.clientId,
        tenantId: website.tenantId,
        action: 'credential_saved',
        // Metadatos, nunca el secreto. Es la regla del repo y aquí importa
        // el doble: la auditoría la leen personas.
        after: {
          host: body.data.host,
          username: body.data.username,
          remotePath: body.data.remotePath,
          hasPassword: true,
        },
        actorType: 'operator',
        actorOperatorId: auth.operatorId === 'legacy' ? null : auth.operatorId,
        actorEmail: operator?.email ?? null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('client_website.credential_save_failed', err, { websiteId: params.websiteId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
