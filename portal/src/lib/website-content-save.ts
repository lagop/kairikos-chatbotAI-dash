import 'server-only';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';
import { legalDataMissing, parseSiteContent } from './site-content';

// =============================================================================
// Guardar el contenido v2 de una web (site-content.ts). Lo usan el editor del
// cliente (PATCH /api/portal/website/[id]/content) y, desde el 28/10/2026, el
// del operador (PATCH /api/admin/portal/websites/[id]/content): es el MISMO
// editor y tiene que guardar exactamente igual, cambiando solo quién firma en
// la auditoría.
//
// Se guarda el contenido entero y se valida con el mismo esquema que usa el
// motor, así que nada que llegue aquí puede dejar la web sin poder pintarse.
// En la auditoría van metadatos (cuántas páginas, bloques, ejemplos
// pendientes…) y no el texto entero: es append-only y crecería sin parar.
// =============================================================================

// El teléfono y la dirección son columnas del sitio (los usan también el
// formulario y la publicación), no del contenido: viajan aparte.
export const SaveContentBodySchema = z.object({
  content: z.unknown(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  // Entrega 6: la versión que el editor tenía al abrirse. El SEO publica
  // artículos en el blog por su cuenta (website-seo-publish.ts) y el editor
  // puede estar abierto: sin esto, su «Guardar» mandaría el contenido de hace
  // un rato y borraría el artículo sin que nadie lo viera. Desde el 28/10
  // también protege de cliente y operador editando a la vez.
  baseUpdatedAt: z.string().datetime().optional(),
});

export type WebsiteActor =
  | { type: 'client'; clientId: string }
  | { type: 'operator'; operatorId: string; email: string | null };

/** Quién firma en ClientWebsiteAudit. */
export function auditActor(actor: WebsiteActor) {
  return actor.type === 'client'
    ? { actorType: 'client', actorEmail: `client:${actor.clientId}` }
    : { actorType: 'operator', actorOperatorId: actor.operatorId, actorEmail: actor.email };
}

class StaleContentError extends Error {}

export type SaveContentResult = { status: number; body: Record<string, unknown> };

export async function saveWebsiteContent(
  prisma: PrismaClient,
  website: { id: string; clientId: string; tenantId: string | null; content: unknown },
  rawBody: unknown,
  actor: WebsiteActor,
): Promise<SaveContentResult> {
  // Solo las webs con contenido v2; las de antes se editan con su editor
  // hasta que el operador las pase.
  if (website.content == null) return { status: 409, body: { error: 'not_v2' } };
  const body = SaveContentBodySchema.safeParse(rawBody);
  if (!body.success) return { status: 400, body: { error: 'invalid_body' } };
  const parsed = parseSiteContent(body.data.content);
  if (!parsed.ok) return { status: 400, body: { error: 'invalid_content', issues: parsed.issues.slice(0, 20) } };
  const content = parsed.content;

  const savedAt = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      // Condicional y atómico: si otra escritura llegó entre medias, no se
      // pisa nada y el editor pide recargar.
      const written = await tx.clientWebsite.updateMany({
        where: { id: website.id, ...(body.data.baseUpdatedAt ? { updatedAt: new Date(body.data.baseUpdatedAt) } : {}) },
        data: {
          updatedAt: savedAt,
          content: content as unknown as object,
          ...(body.data.phone !== undefined ? { phone: body.data.phone || null } : {}),
          ...(body.data.address !== undefined ? { address: body.data.address || null } : {}),
        },
      });
      if (written.count === 0) throw new StaleContentError();
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: website.id,
          clientId: website.clientId,
          tenantId: website.tenantId,
          action: 'content_updated',
          after: {
            version: 2,
            paginas: content.paginas.map((p) => p.ruta || '/'),
            // Solo cuántas y cuáles: el texto de las entradas está en la fila.
            entradasBlog: content.blog.entradas.map((e) => ({ slug: e.slug, publicada: e.publicada })),
            urlPublica: content.urlPublica,
            bloques: content.bloques.length,
            imagenes: { logo: content.imagenes.logo, portada: content.imagenes.portada },
            seccionesOcultas: content.paginas.flatMap((p) => p.secciones.filter((s) => s.oculta).map((s) => s.tipo)),
            ejemplosPendientes: content.ejemplos.length,
            seccionesConfirmadas: content.seccionesConfirmadas,
            datosLegalesCompletos: legalDataMissing(content.legal).length === 0,
          },
          ...auditActor(actor),
        },
      });
    });
    return {
      status: 200,
      body: {
        ok: true,
        ejemplosPendientes: content.ejemplos.length,
        datosLegalesQueFaltan: legalDataMissing(content.legal),
        updatedAt: savedAt.toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof StaleContentError) return { status: 409, body: { error: 'stale_content' } };
    logError('client_website.content_update_failed', err, { websiteId: website.id, actor: actor.type });
    return { status: 500, body: { error: 'internal_error' } };
  }
}
