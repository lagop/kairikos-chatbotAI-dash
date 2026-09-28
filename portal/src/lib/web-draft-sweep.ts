import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';
import { createShareToken } from './prospecting-share';
import { generateWebDraftCopy } from './web-draft-ai';
import { themeFor, VARIANTS_PER_THEME } from './web-draft-html';
import { classifyWebsite } from './prospecting-report';

// =============================================================================
// A11, capa 2 — generar los borradores solos, en el barrido semanal.
//
// La capa 1 era un botón: el comercial abría el borrador del prospecto al
// que iba a llamar. Funciona, pero obliga a esperar unos segundos EN la
// llamada, y eso se nota. Aquí el borrador ya está hecho cuando descuelgas.
//
// Tres límites, y los tres existen porque generar cuesta dinero (~1,8
// céntimos de Sonnet por borrador):
//
// 1. SOLO a quien le sirve: prospectos sin web, o cuya "web" es una ficha en
//    un directorio ajeno (classifyWebsite). A quien ya tiene web propia no se
//    le vende una web, y gastarle un borrador es tirar el dinero.
// 2. TOPE DIARIO duro (DAILY_DRAFT_CAP). Un barrido que encuentra 100
//    prospectos no debe generar 100 borradores de golpe; en la práctica
//    llamarás a unos pocos al día.
// 3. UNA VEZ por prospecto. Si ya tiene borrador, no se regenera: eso es del
//    operador con ?regenerar=1.
//
// El tope es por DÍA y no por ejecución a propósito: el tick corre cada 5
// minutos, así que un tope por ejecución sería un tope por 5 minutos, que no
// limita nada.
// =============================================================================

export const DAILY_DRAFT_CAP = 20;

export interface WebDraftSweepResult {
  candidates: number;
  generated: number;
  skippedNoApiKey: number;
  failed: number;
  capReached: boolean;
}

/**
 * Elige variante de plantilla evitando repetirla entre competidores.
 *
 * Pura y exportada porque es la regla con la que se juega la credibilidad:
 * que dos negocios del MISMO rubro y la MISMA zona reciban la misma web es
 * el único escenario que de verdad hace daño (se conocen entre ellos y se
 * enseñan las cosas). Que se parezcan dos de ciudades distintas no lo ve
 * nadie.
 *
 * `used` son las variantes ya entregadas en ese rubro y zona. Se elige la
 * primera libre; si están todas usadas, se reparte por rotación en vez de
 * fallar — mejor repetir con el cuarto competidor que no tener borrador.
 */
export function pickVariant(themeKey: string, used: string[], rotation: number): string {
  const variants = Array.from({ length: VARIANTS_PER_THEME }, (_, i) => `${themeKey}-${i + 1}`);
  const free = variants.filter((v) => !used.includes(v));
  if (free.length > 0) return free[0];
  return variants[rotation % variants.length];
}

interface SweepCandidate {
  id: string;
  clientId: string;
  tenantId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  website: string | null;
  summary: string | null;
  primaryType: string | null;
  searchCategory: string | null;
  searchLocation: string | null;
}

function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Punto de entrada del cron (desde /api/cron/prospecting-tick). Seguro de
 * llamar más veces de las necesarias: el tope diario se recalcula contra lo
 * ya generado hoy, así que cien ticks en un día generan como mucho
 * DAILY_DRAFT_CAP borradores entre todos.
 */
export async function sweepPendingWebDrafts(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<WebDraftSweepResult> {
  const generatedToday = await prisma.prospectingWebDraft.count({
    where: { generatedAt: { gte: startOfDay(now) } },
  });
  const remaining = DAILY_DRAFT_CAP - generatedToday;
  if (remaining <= 0) {
    return { candidates: 0, generated: 0, skippedNoApiKey: 0, failed: 0, capReached: true };
  }

  // Se piden más de los que caben porque el filtro de "web propia" no se
  // puede hacer en SQL: classifyWebsite mira el dominio contra el nombre del
  // negocio. Se traen candidatos de sobra y se filtran aquí.
  const rows = (await prisma.lead.findMany({
    where: { source: 'outbound', webDraft: { is: null }, contactName: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: remaining * 3,
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      contactName: true,
      contactPhone: true,
      website: true,
      summary: true,
      primaryType: true,
      searchCategory: true,
      searchLocation: true,
    },
  })) as SweepCandidate[];

  const candidates = rows
    .filter((lead) => classifyWebsite(lead.website, lead.contactName) !== 'own')
    .slice(0, remaining);

  let generated = 0;
  let skippedNoApiKey = 0;
  let failed = 0;

  for (const lead of candidates) {
    const businessName = lead.contactName;
    if (!businessName) continue;

    const result = await generateWebDraftCopy({
      businessName,
      primaryType: lead.primaryType,
      category: lead.searchCategory,
      city: lead.searchLocation,
      address: lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
      phone: lead.contactPhone,
      // El barrido no consulta las estrellas: eso es del informe, que las
      // pide a Google y cuesta. Si el prospecto ya tiene informe, la página
      // las enseña igual, porque se leen en el momento de servirla.
      rating: null,
      reviewCount: null,
    });

    if ('skipped' in result) {
      // Sin clave configurada no tiene sentido seguir con el resto del lote.
      skippedNoApiKey += 1;
      break;
    }
    if (!result.ok) {
      failed += 1;
      logError('web_draft_sweep.generate_failed', new Error(result.error), { leadId: lead.id }, 'warn');
      continue;
    }

    const theme = themeFor(lead.primaryType);
    const siblings = await prisma.prospectingWebDraft.findMany({
      where: {
        lead: {
          searchLocation: lead.searchLocation,
          primaryType: lead.primaryType,
        },
      },
      select: { themeKey: true },
    });
    const variant = pickVariant(
      theme.key,
      siblings.map((s) => s.themeKey),
      siblings.length,
    );

    try {
      await prisma.prospectingWebDraft.create({
        data: {
          leadId: lead.id,
          clientId: lead.clientId,
          tenantId: lead.tenantId,
          copy: result.copy as unknown as object,
          themeKey: variant,
          model: result.model,
          generatedAt: now,
          shareToken: createShareToken(),
        },
      });
      generated += 1;
    } catch (err) {
      // El índice único por leadId es el respaldo contra una carrera con
      // otro tick. La generación ya está pagada, así que solo se pierde la
      // fila, no el dinero — y el siguiente barrido no lo reintentará porque
      // el lead ya tendrá borrador.
      failed += 1;
      logError('web_draft_sweep.persist_failed', err, { leadId: lead.id }, 'warn');
    }
  }

  return {
    candidates: candidates.length,
    generated,
    skippedNoApiKey,
    failed,
    capReached: generated >= remaining,
  };
}
