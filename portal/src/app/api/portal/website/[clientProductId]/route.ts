import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Producto Web, Fase 1 — el cliente edita el contenido de SU web.
//
// Lo que puede cambiar y lo que no es la decisión de fondo de este producto:
// el cliente cambia CONTENIDO (textos, servicios, teléfono, dirección) y no
// toca ESTRUCTURA (plantilla, orden de secciones, colores). Así no puede
// romperse su propia web un domingo, que es exactamente la llamada que no
// quieres recibir. Cambiar de plantilla se pide, y lo hace el operador.
//
// El cliente NUNCA ve ni toca la credencial de SFTP: es del operador, está
// cifrada y aquí no se selecciona.
// =============================================================================

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
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  copy: CopySchema,
});

/** El sitio de esta unidad contratada, comprobando que es de quien pregunta.
 *  El clientId sale SIEMPRE de la sesión, nunca del cuerpo ni de la URL: la
 *  URL trae el clientProductId y se filtra por los dos. */
async function resolveWebsite(clientProductId: string) {
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return null;
  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId, clientId: resolved.clientId },
  });
  return website ? { website, clientId: resolved.clientId } : null;
}

export async function PATCH(req: NextRequest, { params }: { params: { clientProductId: string } }) {
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const found = await resolveWebsite(params.clientProductId);
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.clientWebsite.update({
        where: { id: found.website.id },
        data: {
          ...(body.data.phone !== undefined ? { phone: body.data.phone } : {}),
          ...(body.data.address !== undefined ? { address: body.data.address } : {}),
          ...(body.data.city !== undefined ? { city: body.data.city } : {}),
          copy: body.data.copy as unknown as object,
        },
      });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: found.website.id,
          clientId: found.clientId,
          tenantId: found.website.tenantId,
          action: 'content_updated',
          before: { copy: found.website.copy, phone: found.website.phone },
          after: body.data as unknown as object,
          // actorType separa quién escribió: aquí escriben el cliente y el
          // operador sobre la misma fila, y saber cuál importa cuando algo
          // desaparece y hay que explicar por qué.
          actorType: 'client',
          actorEmail: `client:${found.clientId}`,
        },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('client_website.client_update_failed', err, { clientProductId: params.clientProductId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
