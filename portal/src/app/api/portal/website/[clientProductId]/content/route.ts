import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { legalDataMissing, parseSiteContent } from '@/lib/site-content';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — PATCH /api/portal/website/[id]/content
//
// El cliente guarda el contenido v2 de su web (site-content.ts): textos,
// secciones en orden y ocultas, bloques libres, datos legales y qué secciones
// con datos de ejemplo ha confirmado. Sigue la regla del editor de siempre:
// cambia CONTENIDO, nunca la plantilla, que es del operador.
//
// Se guarda el contenido entero y se valida con el mismo esquema que usa el
// motor, así que nada que llegue aquí puede dejar la web sin poder pintarse.
// En la auditoría van metadatos (cuántas páginas, bloques, ejemplos
// pendientes…) y no el texto entero: es append-only y crecería sin parar.
// =============================================================================

// El teléfono y la dirección son columnas del sitio (los usan también el
// formulario y la publicación), no del contenido: viajan aparte.
const BodySchema = z.object({
  content: z.unknown(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  // Entrega 6: la versión que el editor tenía al abrirse. El SEO publica
  // artículos en el blog por su cuenta (website-seo-publish.ts) y el cliente
  // puede tener el editor abierto: sin esto, su «Guardar» mandaría el
  // contenido de hace un rato y borraría el artículo sin que nadie lo viera.
  baseUpdatedAt: z.string().datetime().optional(),
});

class StaleContentError extends Error {}

export async function PATCH(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // El clientId sale de la sesión y se cruza con el de la URL.
  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
    select: { id: true, tenantId: true, content: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Solo las webs con contenido v2; las de antes se editan con su editor
  // (PATCH /api/portal/website/[id]) hasta que el operador las pase.
  if (website.content == null) return NextResponse.json({ error: 'not_v2' }, { status: 409 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const parsed = parseSiteContent(body.data.content);
  if (!parsed.ok) return NextResponse.json({ error: 'invalid_content', issues: parsed.issues.slice(0, 20) }, { status: 400 });
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
          clientId: resolved.clientId,
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
          actorType: 'client',
          actorEmail: `client:${resolved.clientId}`,
        },
      });
    });
    return NextResponse.json({
      ok: true,
      ejemplosPendientes: content.ejemplos.length,
      datosLegalesQueFaltan: legalDataMissing(content.legal),
      updatedAt: savedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof StaleContentError) return NextResponse.json({ error: 'stale_content' }, { status: 409 });
    logError('client_website.content_update_failed', err, { clientProductId: params.clientProductId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
