import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CopySchema = z.object({
  headline: z.string().trim().min(1).max(120),
  subheadline: z.string().trim().max(400).default(''),
  about: z.string().trim().max(1200).default(''),
  services: z
    .array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default('') }))
    .max(12)
    .default([]),
  callToAction: z.string().trim().max(120).default(''),
});

const BodySchema = z.object({
  businessName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  themeKey: z.string().trim().max(40).optional(),
  copy: CopySchema.optional(),
});

/**
 * PATCH /api/admin/portal/websites/[websiteId]
 *
 * Edita el contenido del sitio. Guardar NO publica: el cliente sigue viendo
 * lo último publicado hasta que alguien pulse publicar. Es deliberado —
 * corregir una errata a medias no debe salir a producción sola.
 *
 * Los límites de longitud no son burocracia: la plantilla tiene un sitio
 * para cada cosa, y un titular de 400 caracteres rompe la portada en el
 * móvil de quien lo lea.
 */
export async function PATCH(req: NextRequest, { params }: { params: { websiteId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const website = await prisma.clientWebsite.findUnique({ where: { id: params.websiteId } });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const operator =
    auth.operatorId === 'legacy'
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

  try {
    await prisma.$transaction(async (tx) => {
      await tx.clientWebsite.update({
        where: { id: website.id },
        data: {
          ...(body.data.businessName !== undefined ? { businessName: body.data.businessName } : {}),
          ...(body.data.phone !== undefined ? { phone: body.data.phone } : {}),
          ...(body.data.address !== undefined ? { address: body.data.address } : {}),
          ...(body.data.city !== undefined ? { city: body.data.city } : {}),
          ...(body.data.themeKey !== undefined ? { themeKey: body.data.themeKey } : {}),
          ...(body.data.copy !== undefined ? { copy: body.data.copy as unknown as object } : {}),
        },
      });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: website.id,
          clientId: website.clientId,
          tenantId: website.tenantId,
          action: 'content_updated',
          // El antes y el después completos: la auditoría de contenido es
          // append-only y es lo que permite recuperar un texto que alguien
          // machacó sin querer.
          before: { businessName: website.businessName, themeKey: website.themeKey, copy: website.copy },
          after: body.data as unknown as object,
          actorType: 'operator',
          actorOperatorId: auth.operatorId === 'legacy' ? null : auth.operatorId,
          actorEmail: operator?.email ?? null,
        },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('client_website.update_failed', err, { websiteId: params.websiteId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
