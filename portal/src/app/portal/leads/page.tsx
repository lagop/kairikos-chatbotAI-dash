import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  hasLeadsInboxAccess,
  parseLeadStatusFilter,
  parseLeadSort,
  LEAD_STATUS_FILTERS,
  type LeadStatusFilter,
  type LeadSortOption,
} from '@/lib/leads';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { SelfServeProductCard, type SelfServeTierOption } from '@/components/portal/SelfServeProductCard';
import { LeadStatusControls } from '@/components/portal/LeadStatusControls';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Captación con IA',
  robots: { index: false, follow: false },
};

// =============================================================================
// Real, standalone content page for the 'leads' product ("Sistema IA de
// captación" in the catalog, "Captación con IA" in the portal nav — see
// portal-nav.ts). A real folder (not the generic /portal/[product]
// catch-all), same reasoning as /portal/web: this product now has real
// content (a descriptive pitch + a working purchase CTA) worth its own
// route, per the catch-all's own comment about when a product graduates
// out of it. No entry needed in that page's CANONICAL_HREF map — the
// folder name already matches the product code.
//
// Unlike 'web' (custom-quoted), 'leads' is sold at a fixed price via the
// same self-serve Stripe checkout used on /portal/productos — this page
// reuses SelfServeProductCard rather than inventing a second purchase
// flow.
// =============================================================================

function tierLabel(tier: string): string {
  return tier === 'standard' ? 'Estándar' : tier.charAt(0).toUpperCase() + tier.slice(1);
}

export default async function PortalLeadsPage({
  searchParams,
}: {
  searchParams?: { estado?: string; orden?: string };
}) {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/leads');
  }

  const hasInboxAccess =
    isDatabaseConfigured && resolved.source === 'database'
      ? await hasLeadsInboxAccess(prisma, resolved.clientId)
      : false;

  if (!hasInboxAccess) {
    let leadsTiers: SelfServeTierOption[] = [];
    let leadsPendingProductId: string | null = null;
    let prospectingTiers: SelfServeTierOption[] = [];
    let prospectingPendingProductId: string | null = null;
    if (isDatabaseConfigured && resolved.source === 'database') {
      const [leadsProducts, leadsPendingRow, prospectingProducts, prospectingPendingRow] = await Promise.all([
        prisma.product.findMany({
          where: { code: 'leads', isActive: true },
          orderBy: { priceCents: 'asc' },
          select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
        }),
        prisma.clientProduct.findFirst({
          where: { clientId: resolved.clientId, status: 'pending_payment', product: { code: 'leads' } },
          select: { productId: true },
        }),
        // Fase A de "Prospección con IA" — mostrado como upsell aquí en
        // vez de una segunda página de venta separada. Ambos productos
        // alimentan el mismo buzón de leads (hasLeadsInboxAccess), así
        // que la puerta de entrada económica ('leads') y la de más
        // valor ('prospecting') tienen sentido en la misma pitch.
        prisma.product.findMany({
          where: { code: 'prospecting', isActive: true },
          orderBy: { priceCents: 'asc' },
          select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
        }),
        prisma.clientProduct.findFirst({
          where: { clientId: resolved.clientId, status: 'pending_payment', product: { code: 'prospecting' } },
          select: { productId: true },
        }),
      ]);
      leadsTiers = leadsProducts.map((p) => ({
        productId: p.id,
        tier: p.tier,
        tierLabel: tierLabel(p.tier),
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
      }));
      leadsPendingProductId = leadsPendingRow?.productId ?? null;
      prospectingTiers = prospectingProducts.map((p) => ({
        productId: p.id,
        tier: p.tier,
        tierLabel: tierLabel(p.tier),
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
      }));
      prospectingPendingProductId = prospectingPendingRow?.productId ?? null;
    }

    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Portal"
          title="Captación con IA"
          description="Un sistema de IA que prioriza tus contactos, para que tu equipo se enfoque en los que realmente van a convertir."
        />
        <ProductPitch
          tagline="Menos tiempo filtrando consultas a mano, más tiempo cerrando ventas."
          features={[
            'La IA analiza cada contacto entrante y lo prioriza según su probabilidad de convertirse en cliente.',
            'Tu equipo ve primero los leads que más importan, no una lista sin ordenar.',
            'Configuración incluida en el alta — no hace falta que tu equipo aprenda nada nuevo.',
          ]}
        >
          {isDatabaseConfigured && resolved.source === 'database' && leadsTiers.length > 0 ? (
            leadsPendingProductId ? (
              <SelfServeProductCard code="leads" label="Captación con IA" status="pending" productId={leadsPendingProductId} />
            ) : (
              <SelfServeProductCard code="leads" label="Captación con IA" status="available" tiers={leadsTiers} />
            )
          ) : (
            <EmptyState
              title="No disponible en modo demo"
              description="La contratación de productos requiere una cuenta real conectada a facturación."
            />
          )}
        </ProductPitch>

        {isDatabaseConfigured && resolved.source === 'database' && prospectingTiers.length > 0 ? (
          <ProductPitch
            tagline="¿Y si además saliéramos a buscarte clientes nuevos? Prospección con IA."
            features={[
              'Encontramos negocios reales en tu zona y tu rubro — no solo priorizamos, buscamos.',
              'Los prospectos aparecen aquí mismo, en la misma lista, junto a los que ya te escriben.',
              'Tú decides el rubro y la zona desde tu propio panel — sin esperar a nadie.',
            ]}
          >
            {prospectingPendingProductId ? (
              <SelfServeProductCard code="prospecting" label="Prospección con IA" status="pending" productId={prospectingPendingProductId} />
            ) : (
              <SelfServeProductCard code="prospecting" label="Prospección con IA" status="available" tiers={prospectingTiers} />
            )}
          </ProductPitch>
        ) : null}
      </div>
    );
  }

  // Leads Fase 4 — no hay paso de "setup" real para este producto (su
  // catálogo del wizard es un emptyCatalog, y ClientProduct.onboardingState
  // nunca llega a 'live' para 'leads' — el único código que lo escribe
  // está hardcodeado a chatbot). En cuanto isProductContracted es true, el
  // panel real se muestra directamente, sin esperar ningún estado extra.
  //
  // Leads Fase 8 — estado y orden vienen de la query string, validados
  // con la misma disciplina que recall-client-view.ts: un valor
  // desconocido u hostil nunca rompe la página, cae al valor por
  // defecto (todos los estados, más recientes primero).
  const statusFilter = parseLeadStatusFilter(searchParams?.estado);
  const sort = parseLeadSort(searchParams?.orden);

  const leads = await prisma.lead.findMany({
    where: { clientId: resolved.clientId, ...(statusFilter ? { status: statusFilter } : {}) },
    orderBy:
      sort === 'prioridad'
        ? [{ score: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }],
  });

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Portal"
        title="Captación con IA"
        description="Los contactos que la IA ha priorizado para ti."
      />

      <LeadsFilterBar statusFilter={statusFilter} sort={sort} />

      {leads.length === 0 ? (
        <EmptyState
          title={statusFilter ? 'Ningún lead con ese estado' : 'Sin leads todavía'}
          description={
            statusFilter
              ? 'Prueba a quitar el filtro para ver el resto de tus leads.'
              : 'En cuanto la IA detecte un contacto interesado en una conversación, aparecerá aquí.'
          }
        />
      ) : (
        <section className="space-y-3" data-testid="leads-list">
          {leads.map((lead) => (
            <LeadRow key={lead.id} lead={lead} />
          ))}
        </section>
      )}
    </div>
  );
}

const STATUS_FILTER_LABEL: Record<LeadStatusFilter, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  convertido: 'Convertido',
  descartado: 'Descartado',
};

/** Plain query-param navigation, same convention as MonthLink/PageLink
 *  in /portal/llamadas — no client component needed for a set of links
 *  that just change which page renders. */
function LeadsFilterBar({ statusFilter, sort }: { statusFilter: LeadStatusFilter | null; sort: LeadSortOption }) {
  function href(overrides: { estado?: LeadStatusFilter | null; orden?: LeadSortOption }): string {
    const params = new URLSearchParams();
    const nextStatus = 'estado' in overrides ? overrides.estado : statusFilter;
    const nextSort = overrides.orden ?? sort;
    if (nextStatus) params.set('estado', nextStatus);
    if (nextSort !== 'recientes') params.set('orden', nextSort);
    const qs = params.toString();
    return qs ? `/portal/leads?${qs}` : '/portal/leads';
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <nav className="flex flex-wrap items-center gap-2" aria-label="Filtrar por estado" data-testid="leads-status-filter">
        <Link
          href={href({ estado: null })}
          className={statusFilter === null ? 'pill-success' : 'pill-muted'}
          data-testid="leads-filter-todos"
        >
          Todos
        </Link>
        {LEAD_STATUS_FILTERS.map((status) => (
          <Link
            key={status}
            href={href({ estado: status })}
            className={statusFilter === status ? 'pill-success' : 'pill-muted'}
            data-testid={`leads-filter-${status}`}
          >
            {STATUS_FILTER_LABEL[status]}
          </Link>
        ))}
      </nav>
      <nav className="flex items-center gap-2" aria-label="Ordenar" data-testid="leads-sort">
        <Link
          href={href({ orden: 'recientes' })}
          className={sort === 'recientes' ? 'font-semibold text-kairikos-text' : 'text-kairikos-accent2 hover:underline'}
          data-testid="leads-sort-recientes"
        >
          Más recientes
        </Link>
        <span className="text-kairikos-muted">·</span>
        <Link
          href={href({ orden: 'prioridad' })}
          className={sort === 'prioridad' ? 'font-semibold text-kairikos-text' : 'text-kairikos-accent2 hover:underline'}
          data-testid="leads-sort-prioridad"
        >
          Mayor prioridad
        </Link>
      </nav>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  convertido: 'Convertido',
  descartado: 'Descartado',
};

const STATUS_PILL: Record<string, string> = {
  nuevo: 'pill-warning',
  contactado: 'pill-warning',
  convertido: 'pill-success',
  descartado: 'pill-muted',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function LeadRow({
  lead,
}: {
  lead: {
    id: string;
    status: string;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    summary: string | null;
    score: number | null;
    scoreReason: string | null;
    channel: string | null;
    source: string;
    createdAt: Date;
  };
}) {
  const contactParts = [lead.contactName, lead.contactPhone, lead.contactEmail].filter(Boolean);
  return (
    <div className="card space-y-2" data-testid="lead-row" data-status={lead.status} data-source={lead.source}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">
            {DATE_FMT.format(lead.createdAt)}
            {lead.channel ? ` · ${lead.channel}` : ''}
          </p>
          <h3 className="mt-1 text-base font-semibold">
            {contactParts.length > 0 ? contactParts.join(' · ') : 'Sin datos de contacto'}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {lead.source === 'outbound' ? (
            <span
              className="pill-muted"
              data-testid="lead-source-outbound"
              title="Lo encontramos nosotros — Prospección con IA, no te escribió."
            >
              Prospección
            </span>
          ) : null}
          {lead.score !== null ? (
            <span className="pill-muted" data-testid="lead-score" title={lead.scoreReason ?? undefined}>
              Prioridad {lead.score}
            </span>
          ) : null}
          <span className={STATUS_PILL[lead.status] ?? 'pill-muted'} data-testid="lead-status-pill">
            {STATUS_LABEL[lead.status] ?? lead.status}
          </span>
        </div>
      </div>
      {lead.summary ? <p className="text-sm text-kairikos-text">{lead.summary}</p> : null}
      {lead.scoreReason ? (
        <p className="text-xs italic text-kairikos-muted" data-testid="lead-score-reason">
          Por qué esta prioridad: {lead.scoreReason}
        </p>
      ) : null}
      <LeadStatusControls
        leadId={lead.id}
        status={lead.status as 'nuevo' | 'contactado' | 'convertido' | 'descartado'}
      />
    </div>
  );
}
