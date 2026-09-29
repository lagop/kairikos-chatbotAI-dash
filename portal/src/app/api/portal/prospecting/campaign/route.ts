import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  TIER_LEAD_CAP,
  MAX_SEARCHES_PER_CAMPAIGN,
  normalizeSearches,
  diffSearches,
  type SearchSpec,
} from '@/lib/prospecting';
import { logError } from '@/lib/observability';
import { normalizarPresentacion, PRESENTACION_MAX } from '@/lib/prospecting-presentacion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Prospección con IA, Fase A — PATCH /api/portal/prospecting/campaign
//
// Client self-serve, deliberately: see prospecting.ts's header and the
// session's own plan for why this is NOT an operator-managed setting —
// there is no technical complexity here (unlike Meta Coexistence) that
// would justify intermediation, and putting the operator in the loop
// for every zone/category change works against why this product exists.
//
// Fase 6 — the row itself is normally already there by the time this
// runs: ensureProspectingCampaign (product-onboarding.ts) creates it
// empty at purchase time, with monthlyLeadCap already set from the
// contracted tier. The lazy `create` below stays as the fallback for a
// row that predates that hook, or the rare case where the hook's own
// write failed silently — this PATCH must keep working either way.
//
// 29/09/2026 — varias búsquedas. El cliente manda la lista entera de
// combinaciones de rubro y zona (`searches`) y la ruta la deja así en
// ProspectingSearch, conservando las que siguen (ver diffSearches). El radio
// desaparece: nunca llegó a Google.
// =============================================================================

const OPTIONAL_TEXT = z.string().trim().max(2000).nullish();

const SEARCH = z.object({
  category: z.string().max(200),
  locationQuery: z.string().max(200),
});

const BodySchema = z.object({
  // Holgura sobre el máximo para que la ruta, y no zod, diga «demasiadas»
  // con su propio código, después de quitar las vacías y las repetidas.
  searches: z.array(SEARCH).max(MAX_SEARCHES_PER_CAMPAIGN * 2).optional(),
  // El formato de antes del 29/09/2026: un solo rubro y una sola zona. Se
  // sigue aceptando para una pestaña abierta con la versión anterior del
  // portal durante el despliegue; se puede quitar pasados unos días.
  category: z.string().max(200).optional(),
  locationQuery: z.string().max(200).optional(),
  // Fase A — el contexto del negocio del cliente, con el que se le sugieren
  // rubros y zonas (ver prospecting-brief-ai.ts). Opcional: quien ya sabe a
  // quién buscar sigue guardando solo rubro y zona, como hasta ahora.
  clientWebsite: z.string().trim().max(500).nullish(),
  businessDescription: OPTIONAL_TEXT,
  idealCustomer: OPTIONAL_TEXT,
  exclusions: OPTIONAL_TEXT,
  // «Nos dedicamos a …» — el {{3}} del primer mensaje. Holgura en zod para
  // que sea la ruta, y no el esquema, quien diga «demasiado larga» con su
  // propio código — ver más abajo.
  presentacion: z.string().max(PRESENTACION_MAX * 3).nullish(),
});

/** Solo los campos del brief que vinieron en la petición: lo que no se manda
 *  no se pisa, y una cadena vacía borra. */
function briefFields(data: z.infer<typeof BodySchema>) {
  const out: Record<string, string | null> = {};
  for (const key of ['clientWebsite', 'businessDescription', 'idealCustomer', 'exclusions'] as const) {
    const value = data[key];
    if (value !== undefined) out[key] = value && value.length > 0 ? value : null;
  }
  return out;
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const requested: SearchSpec[] =
    body.data.searches ??
    (body.data.category !== undefined && body.data.locationQuery !== undefined
      ? [{ category: body.data.category, locationQuery: body.data.locationQuery }]
      : []);
  const searches = normalizeSearches(requested);
  if (searches.length === 0) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (searches.length > MAX_SEARCHES_PER_CAMPAIGN) {
    return NextResponse.json({ error: 'demasiadas_busquedas', max: MAX_SEARCHES_PER_CAMPAIGN }, { status: 400 });
  }

  // La presentación se normaliza al guardar —la misma función que la última
  // puerta antes de WhatsApp— y lo que no cabe se RECHAZA en vez de cortarse:
  // una frase partida a la mitad, dentro de un mensaje con el nombre del
  // cliente, es peor que pedirle que la acorte.
  let presentacion: string | null | undefined = undefined;
  if (body.data.presentacion !== undefined) {
    presentacion = normalizarPresentacion(body.data.presentacion);
    if (presentacion && presentacion.length > PRESENTACION_MAX) {
      return NextResponse.json({ error: 'presentacion_demasiado_larga', max: PRESENTACION_MAX }, { status: 400 });
    }
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId: resolved.clientId, status: 'active', product: { code: 'prospecting' } },
    select: { id: true, tenantId: true, product: { select: { tier: true } } },
  });
  if (!clientProduct) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const existing = await prisma.prospectingCampaign.findUnique({
    where: { clientProductId: clientProduct.id },
    select: {
      id: true,
      presentacion: true,
      searches: { select: { id: true, category: true, locationQuery: true }, orderBy: { createdAt: 'asc' } },
    },
  });

  const listForAudit = (list: readonly SearchSpec[]) =>
    list.map((x) => ({ category: x.category, locationQuery: x.locationQuery }));

  let campaign;
  try {
    if (existing) {
      // La presentación SÍ entra en la auditoría, a diferencia del resto del
      // brief: es texto que se envía con el nombre del cliente a un
      // desconocido. Si alguien pregunta «¿quién escribió esto en mi nombre?»,
      // la respuesta tiene que estar aquí.
      const before = {
        searches: listForAudit(existing.searches),
        presentacion: existing.presentacion,
      };
      const diff = diffSearches(existing.searches, searches);
      campaign = await prisma.$transaction(async (tx) => {
        if (diff.deleteIds.length > 0) {
          await tx.prospectingSearch.deleteMany({ where: { id: { in: diff.deleteIds }, campaignId: existing.id } });
        }
        for (const row of diff.update) {
          await tx.prospectingSearch.update({
            where: { id: row.id },
            data: { category: row.category, locationQuery: row.locationQuery },
          });
        }
        if (diff.create.length > 0) {
          await tx.prospectingSearch.createMany({
            data: diff.create.map((x) => ({ campaignId: existing.id, ...x })),
          });
        }
        const updated = await tx.prospectingCampaign.update({
          where: { id: existing.id },
          data: {
            ...briefFields(body.data),
            ...(presentacion !== undefined ? { presentacion } : {}),
          },
        });
        await tx.prospectingCampaignAudit.create({
          data: {
            campaignId: updated.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'profile_updated',
            before,
            after: { searches: listForAudit(searches), presentacion: updated.presentacion },
            actorId: `client:${resolved.clientId}`,
          },
        });
        return updated;
      });
    } else {
      campaign = await prisma.$transaction(async (tx) => {
        const created = await tx.prospectingCampaign.create({
          data: {
            clientId: resolved.clientId,
            clientProductId: clientProduct.id,
            tenantId: clientProduct.tenantId,
            searches: { create: searches },
            ...briefFields(body.data),
            ...(presentacion !== undefined ? { presentacion } : {}),
            monthlyLeadCap: TIER_LEAD_CAP[clientProduct.product.tier] ?? TIER_LEAD_CAP.solo,
          },
        });
        await tx.prospectingCampaignAudit.create({
          data: {
            campaignId: created.id,
            clientId: resolved.clientId,
            tenantId: clientProduct.tenantId,
            action: 'created',
            before: Prisma.JsonNull,
            after: { searches: listForAudit(searches), presentacion: created.presentacion },
            actorId: `client:${resolved.clientId}`,
          },
        });
        return created;
      });
    }
  } catch (err) {
    logError('prospecting_campaign.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, campaign: { id: campaign.id, searches } });
}
