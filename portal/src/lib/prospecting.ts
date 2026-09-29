import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isGooglePlacesConfigured, searchPlaces, getPlaceDetails } from './google-places';
import { logError } from './observability';

// =============================================================================
// Prospección con IA, Fase A — runProspectingSearch is the whole engine:
// one campaign run turns a client's target profile (since 29/09/2026,
// several combinations of category + zone) into new Lead rows, respecting
// a monthly cost cap shared by all of them. No contact happens
// here or anywhere in Fase A — see the plan.
//
// The billing invariant this module exists to protect: leadsFoundThisMonth
// must stay 1:1 with real Google Places Details calls made (the ones that
// actually cost money — see google-places.ts's getPlaceDetails comment),
// NOT with Lead rows created. A closed business still burns a Details
// call even though no Lead comes out of it, so it still counts against
// the cap — undercounting it would let a campaign quietly cost more than
// its tier's price was set to cover.
// =============================================================================

/** monthlyLeadCap for a freshly-created ProspectingCampaign, by
 *  Product.tier — matches the "Prospectos/mes" column of the pricing
 *  table in prisma/seed.ts exactly. Single source of truth so the cap a
 *  client's campaign gets on first save can never drift from what their
 *  tier was priced to cover. */
export const TIER_LEAD_CAP: Readonly<Record<string, number>> = Object.freeze({
  solo: 100,
  team: 300,
  business: 800,
});

/** Cuántas combinaciones de rubro y zona puede tener una campaña. No es el
 *  freno del gasto —ese es monthlyLeadCap, que todas comparten—, sino de las
 *  llamadas de Text Search: cada búsqueda gasta hasta MAX_PAGES_PER_SEARCH
 *  por barrido semanal. Diez búsquedas × tres páginas × ~4,3 barridos son
 *  unas 130 llamadas al mes por campaña, frente a 10.000 gratis al mes
 *  (docs/costes-y-topes.md). Igual para todas las tarifas: una búsqueda más
 *  no cuesta fichas de más, así que no es algo que cobrar. */
export const MAX_SEARCHES_PER_CAMPAIGN = 10;

/** Cuántas páginas de 20 pide cada búsqueda en un barrido, como mucho.
 *  Hasta el 29/09/2026 era una sola: la segunda semana Google devolvía los
 *  mismos 20 negocios, ya guardados, y el barrido no encontraba nada nuevo
 *  aunque quedaran cientos en la zona. Text Search da hasta 60 resultados
 *  por consulta (3 páginas); se pasa a la siguiente solo si hace falta. */
export const MAX_PAGES_PER_SEARCH = 3;

export interface ProspectingSearchInput {
  id: string;
  category: string;
  locationQuery: string;
  lastRunAt: Date | null;
}

export interface ProspectingCampaignInput {
  id: string;
  clientId: string;
  tenantId: string | null;
  searches: ProspectingSearchInput[];
  leadsFoundThisMonth: number;
  monthlyLeadCap: number;
  usageResetAt: Date;
  alertedAt: Date | null;
}

export type RunProspectingSearchResult =
  | {
      ok: true;
      created: number;
      skippedDuplicate: number;
      skippedClosed: number;
      detailsCallsMade: number;
      capReached: boolean;
      /** Búsquedas que llegaron a preguntar a Google en esta pasada. */
      searchesRun: number;
    }
  | { ok: false; error: 'not_configured' | 'campaign_not_ready' | 'search_failed' };

/** UTC calendar month, not per-client local time — this is a cost quota,
 *  not a client-facing report boundary, so it doesn't need
 *  recall-reports.ts's timezone precision. */
function isNewCalendarMonth(usageResetAt: Date, now: Date): boolean {
  return usageResetAt.getUTCFullYear() !== now.getUTCFullYear() || usageResetAt.getUTCMonth() !== now.getUTCMonth();
}

/** Prospects don't need to be found in real time — a weekly cadence is
 *  the target, and this is the isDigestDue-equivalent that decides
 *  whether THIS tick is the one that runs it: null lastRunAt (never
 *  run) is always due. Revalidated on every cron tick rather than
 *  trusted from the scheduler's own cadence, same reasoning as
 *  conversation-digest.ts's isDigestDue — the scheduler can be coarser
 *  than the target without a campaign ever getting skipped outright. */
export const PROSPECTING_RUN_INTERVAL_DAYS = 7;

export function isProspectingRunDue(lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (lastRunAt === null) return true;
  const elapsedDays = (now.getTime() - lastRunAt.getTime()) / (24 * 60 * 60 * 1000);
  return elapsedDays >= PROSPECTING_RUN_INTERVAL_DAYS;
}

/**
 * One run of one campaign. Safe to call more often than the campaign
 * actually needs (same posture as every job in recall-tick) — a
 * duplicate-heavy run just does less new work, it never double-charges
 * or double-creates, because every candidate is checked against
 * Lead.externalPlaceId before a single Details call is spent on it.
 */
export async function runProspectingSearch(
  prisma: PrismaClient,
  campaign: ProspectingCampaignInput,
  now: Date = new Date(),
): Promise<RunProspectingSearchResult> {
  if (!(await isGooglePlacesConfigured())) {
    return { ok: false, error: 'not_configured' };
  }
  if (campaign.searches.length === 0) {
    // The client hasn't filled in their target profile yet — nothing to
    // search for. Not an error, just nothing to do this tick.
    return { ok: false, error: 'campaign_not_ready' };
  }

  let leadsFoundThisMonth = campaign.leadsFoundThisMonth;
  let usageResetAt = campaign.usageResetAt;
  let alertedAt = campaign.alertedAt;
  if (isNewCalendarMonth(usageResetAt, now)) {
    leadsFoundThisMonth = 0;
    usageResetAt = now;
    alertedAt = null;
  }

  const remaining = campaign.monthlyLeadCap - leadsFoundThisMonth;
  if (remaining <= 0) {
    // Warn once per cap breach (alertedAt), same pattern as
    // RecallUsageMonth.alertedAt in recall-reports.ts's rollUpUsage —
    // never spam every tick after the cap is hit.
    if (!alertedAt) {
      await prisma.prospectingCampaign.update({
        where: { id: campaign.id },
        data: { alertedAt: now, leadsFoundThisMonth, usageResetAt },
      });
    }
    return {
      ok: true,
      created: 0,
      skippedDuplicate: 0,
      skippedClosed: 0,
      detailsCallsMade: 0,
      capReached: true,
      searchesRun: 0,
    };
  }

  // Varias búsquedas (29/09/2026). El tope del mes es de la CAMPAÑA y se
  // reparte: cada búsqueda recibe su parte de lo que queda y lo que no gasta
  // pasa a las siguientes. Empieza la que lleva más tiempo sin atender, para
  // que un mes con poco margen no se lo coma siempre la primera de la lista.
  const searches = [...campaign.searches].sort(
    (a, b) => (a.lastRunAt?.getTime() ?? 0) - (b.lastRunAt?.getTime() ?? 0),
  );

  // Un mismo negocio sale a menudo en dos búsquedas («reformas» y «reformas
  // de baños» en la misma zona). Los que ya se procesaron en esta pasada se
  // recuerdan aquí para no pagar su ficha dos veces; entre pasadas ya lo
  // evita la consulta a Lead.externalPlaceId. Solo los PROCESADOS: uno que
  // una búsqueda encontró pero no llegó a procesar (su parte del tope se
  // acabó) lo puede recoger la siguiente.
  const processedThisRun = new Set<string>();

  let created = 0;
  let skippedClosed = 0;
  let skippedDuplicate = 0;
  let detailsCallsMade = 0;
  let searchesRun = 0;
  let searchesFailed = 0;

  for (let i = 0; i < searches.length; i++) {
    const budgetLeft = remaining - detailsCallsMade;
    if (budgetLeft <= 0) break;
    const search = searches[i];
    const share = Math.ceil(budgetLeft / (searches.length - i));

    // Página a página hasta tener `share` negocios nuevos o quedarse sin
    // páginas. Se pasa a la siguiente solo si hace falta: cada página es una
    // llamada de Text Search.
    const textQuery = `${search.category} en ${search.locationQuery}`;
    const fresh: Array<{ id: string }> = [];
    const freshIds = new Set<string>();
    let pageToken: string | undefined;
    let failed = false;
    for (let page = 0; page < MAX_PAGES_PER_SEARCH && fresh.length < share; page++) {
      const searchResult = await searchPlaces({ textQuery, ...(pageToken ? { pageToken } : {}) });
      if (!searchResult.ok) {
        logError(
          'prospecting.search_failed',
          new Error(searchResult.error),
          { campaignId: campaign.id, searchId: search.id, page },
          'warn',
        );
        failed = page === 0;
        break;
      }

      const candidateIds = searchResult.data.results
        .map((r) => r.id)
        .filter((id) => !processedThisRun.has(id) && !freshIds.has(id));
      const existing =
        candidateIds.length > 0
          ? await prisma.lead.findMany({
              where: { clientId: campaign.clientId, externalPlaceId: { in: candidateIds } },
              select: { externalPlaceId: true },
            })
          : [];
      const existingIds = new Set(existing.map((r) => r.externalPlaceId));
      for (const id of candidateIds) {
        if (existingIds.has(id)) continue;
        freshIds.add(id);
        fresh.push({ id });
      }

      pageToken = searchResult.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    if (failed) {
      searchesFailed += 1;
      continue;
    }
    searchesRun += 1;

    // Never spend more Details calls than this search's share of the
    // remaining monthly budget, even if it turned up more new businesses.
    const toProcess = fresh.slice(0, share);
    skippedDuplicate += fresh.length - toProcess.length;
    for (const candidate of toProcess) processedThisRun.add(candidate.id);
    const outcome = await processCandidates(prisma, campaign, search, toProcess);
    created += outcome.created;
    skippedClosed += outcome.skippedClosed;
    detailsCallsMade += outcome.detailsCallsMade;

    await prisma.prospectingSearch.update({ where: { id: search.id }, data: { lastRunAt: now } });
  }

  // Todas fallaron: mismo resultado que cuando había una sola búsqueda, y la
  // campaña no se da por atendida (lastRunAt no se mueve), así que el
  // siguiente tick lo vuelve a intentar.
  if (searchesRun === 0 && searchesFailed > 0) {
    return { ok: false, error: 'search_failed' };
  }

  const newLeadsFoundThisMonth = leadsFoundThisMonth + detailsCallsMade;
  const capReached = newLeadsFoundThisMonth >= campaign.monthlyLeadCap;
  await prisma.prospectingCampaign.update({
    where: { id: campaign.id },
    data: {
      leadsFoundThisMonth: newLeadsFoundThisMonth,
      usageResetAt,
      lastRunAt: now,
      // Newly reached this run → stamp it. Already past it from a prior
      // run → alertedAt is already set from that run's own update, so
      // this branch never re-fires; not reached → clear it (a campaign
      // whose cap was raised, or that rolled into a new month, gets
      // warned again next time it genuinely hits the new cap).
      alertedAt: capReached ? (alertedAt ?? now) : null,
    },
  });

  return {
    ok: true,
    created,
    skippedDuplicate,
    skippedClosed,
    detailsCallsMade,
    capReached,
    searchesRun,
  };
}

/**
 * Las fichas (Place Details) de los candidatos nuevos de UNA búsqueda, y un
 * Lead por cada negocio abierto. Aquí vive la invariante de cobro: cada
 * llamada de Details que se hizo cuenta, haya salido lead o no.
 */
async function processCandidates(
  prisma: PrismaClient,
  campaign: ProspectingCampaignInput,
  search: ProspectingSearchInput,
  candidates: ReadonlyArray<{ id: string }>,
): Promise<{ created: number; skippedClosed: number; detailsCallsMade: number }> {
  let created = 0;
  let skippedClosed = 0;
  let detailsCallsMade = 0;

  for (const candidate of candidates) {
    const details = await getPlaceDetails(candidate.id);
    if (!details.ok) {
      // A failed call is neither billed success nor a lead — doesn't
      // count against detailsCallsMade, doesn't create a row. Logged so
      // a pattern of failures (bad key, quota exhausted) is visible.
      logError(
        'prospecting.details_failed',
        new Error(details.error),
        { campaignId: campaign.id, placeId: candidate.id },
        'warn',
      );
      continue;
    }
    detailsCallsMade += 1;

    if (details.data.businessStatus === 'CLOSED_PERMANENTLY') {
      // Still billed (the call was made), but not a real prospect — no
      // Lead for a business that no longer exists.
      skippedClosed += 1;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const lead = await tx.lead.create({
          data: {
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            source: 'outbound',
            channel: 'places',
            status: 'nuevo',
            externalPlaceId: candidate.id,
            // Fase 3.4 — el rubro y la zona con los que se encontró a este
            // negocio, congelados aquí. Con varias búsquedas es además la
            // única forma de saber cuál lo encontró.
            searchCategory: search.category,
            searchLocation: search.locationQuery,
            contactName: details.data.name,
            contactPhone: details.data.phoneNumber,
            website: details.data.websiteUri,
            // A1 — coordenadas y categoría de Google, que este mismo Place
            // Details ya devolvía y se tiraban. Son campos Essentials: no
            // encarecen ni un céntimo esta llamada, y sin ellos el informe
            // comparativo tendría que volver a geocodificar el negocio.
            latitude: details.data.latitude,
            longitude: details.data.longitude,
            primaryType: details.data.primaryType,
            summary: details.data.formattedAddress
              ? `Negocio encontrado en ${details.data.formattedAddress}.`
              : null,
          },
        });
        await tx.leadAudit.create({
          data: {
            leadId: lead.id,
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            action: 'created',
            statusBefore: null,
            statusAfter: 'nuevo',
            actorId: 'system:prospecting',
          },
        });
      });
      created += 1;
    } catch (err) {
      // Lead.@@unique([clientId, externalPlaceId]) is the backstop
      // against a race with another concurrent run of the same
      // campaign — the pre-check above makes this rare, not impossible.
      // The Details call was still billed either way, so
      // detailsCallsMade above already accounts for the cost; only the
      // Lead itself failed to persist.
      logError('prospecting.lead_persist_failed', err, { campaignId: campaign.id, placeId: candidate.id }, 'warn');
    }
  }

  return { created, skippedClosed, detailsCallsMade };
}

// =============================================================================
// Guardar las búsquedas que manda el cliente (29/09/2026).
//
// El formulario manda la lista entera cada vez; lo que no viene, se borra.
// Pero una búsqueda que sigue en la lista NO se borra y se vuelve a crear:
// conserva su lastRunAt, que es lo que decide a quién atiende primero el
// barrido. Recrearlas todas en cada guardado haría que cualquier cambio
// menor —añadir una zona— las pusiera a todas como nunca atendidas.
//
// Puras y exportadas para probarlas sin base de datos.
// =============================================================================

export interface SearchSpec {
  category: string;
  locationQuery: string;
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Dos búsquedas son la misma si solo cambian mayúsculas o espacios. */
export function searchKey(search: SearchSpec): string {
  return `${collapse(search.category).toLowerCase()}\u0000${collapse(search.locationQuery).toLowerCase()}`;
}

/** Recorta, junta espacios, descarta las que no tienen rubro o zona y
 *  quita las repetidas (se queda la primera). */
export function normalizeSearches(list: readonly SearchSpec[]): SearchSpec[] {
  const seen = new Set<string>();
  const out: SearchSpec[] = [];
  for (const raw of list) {
    const search = { category: collapse(raw.category), locationQuery: collapse(raw.locationQuery) };
    if (!search.category || !search.locationQuery) continue;
    const key = searchKey(search);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(search);
  }
  return out;
}

/** Qué hay que borrar, crear y retocar para pasar de lo guardado a lo que
 *  quiere el cliente. Retocar = la misma búsqueda escrita de otra forma
 *  («Reformas» → «reformas»): se corrige el texto y se conserva la fila. */
export function diffSearches(
  existing: ReadonlyArray<SearchSpec & { id: string }>,
  wanted: readonly SearchSpec[],
): { deleteIds: string[]; create: SearchSpec[]; update: Array<SearchSpec & { id: string }> } {
  const existingByKey = new Map(existing.map((row) => [searchKey(row), row]));
  const wantedKeys = new Set(wanted.map(searchKey));

  const update: Array<SearchSpec & { id: string }> = [];
  const create: SearchSpec[] = [];
  for (const search of wanted) {
    const row = existingByKey.get(searchKey(search));
    if (!row) create.push(search);
    else if (row.category !== search.category || row.locationQuery !== search.locationQuery) {
      update.push({ id: row.id, ...search });
    }
  }

  return {
    deleteIds: existing.filter((row) => !wantedKeys.has(searchKey(row))).map((row) => row.id),
    create,
    update,
  };
}
