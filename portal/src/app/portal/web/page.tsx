import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { canAccessWebProduct } from '@/lib/client-product-access';
import { resolveWebQuoteContext } from '@/lib/web-quotes';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { RequestWebQuoteCard } from '@/components/portal/RequestWebQuoteCard';
import { WebBriefForm, type WebBriefFormValues } from '@/components/portal/WebBriefForm';
import { WebQuoteCard, type ClientWebQuoteData, type ClientWebQuoteInvoiceData } from '@/components/portal/WebQuoteCard';
import { GOAL_LABELS, CONTENT_PROVIDED_BY_LABELS, type GOAL_OPTIONS, type CONTENT_PROVIDED_BY_OPTIONS } from '@/lib/web-brief-schema';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plataforma web profesional · Portal Kairikos',
  robots: { index: false, follow: false },
};

// =============================================================================
// Real, standalone content page for the 'web' product — see
// prisma/schema.prisma's WebBrief model comment for why this is a single
// form, not a multi-step wizard reusing the chatbot's engine.
//
// This is a real folder (not the generic /portal/[product] catch-all), so
// Next.js resolves requests to /portal/web here automatically — no entry
// needed in that page's CANONICAL_HREF map (that map only exists for
// products whose real folder name differs from their product code;
// 'web' already matches).
// =============================================================================

function jsonToStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export default async function PortalWebPage({ searchParams }: { searchParams: { edit?: string } }) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/web');
  }

  const hasWeb =
    isDatabaseConfigured && resolved.source === 'database'
      ? await canAccessWebProduct(prisma, resolved.clientId)
      : false;

  if (!hasWeb) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title="Plataforma web profesional" />
        <ProductPitch
          tagline="Un sitio hecho a tu medida, no una plantilla genérica."
          features={[
            'Páginas a tu medida: inicio, servicios, sobre nosotros, contacto, blog, precios, testimonios y más.',
            'Integraciones reales: WhatsApp, calendario de citas, CRM, formulario de contacto, pagos online.',
            'Vos elegís quién escribe los textos — los enviás vos, los redactamos nosotros, o un poco de cada uno.',
          ]}
          priceNote="Proyectos desde 799 €, según el alcance."
        >
          <RequestWebQuoteCard label="Plataforma web profesional" />
        </ProductPitch>
      </div>
    );
  }

  // WebQuote Fase 4 — while the 'web' ClientProduct is still in
  // 'quote_pending' (pre-payment), show the quote status above the
  // brief. Once it flips to 'active', this stays null and the page
  // behaves exactly as before.
  let isQuotePending = false;
  let webQuote: ClientWebQuoteData | null = null;
  let webQuoteInvoice: ClientWebQuoteInvoiceData | null = null;
  if (isDatabaseConfigured && resolved.source === 'database') {
    const context = await resolveWebQuoteContext(prisma, resolved.clientId);
    if (context?.clientProduct.status === 'quote_pending') {
      isQuotePending = true;
      webQuote = context.webQuote
        ? {
            status: context.webQuote.status,
            amountCents: context.webQuote.amountCents,
            depositCents: context.webQuote.depositCents,
            currency: context.webQuote.currency,
            description: context.webQuote.description,
          }
        : null;
      if (
        context.webQuote &&
        ['invoiced', 'invoiced_deposit', 'invoiced_final', 'paid'].includes(context.webQuote.status)
      ) {
        const invoiceRow = await prisma.invoice.findFirst({
          where: { clientProductId: context.clientProduct.id },
          orderBy: { createdAt: 'desc' },
          select: { hostInvoiceUrl: true },
        });
        webQuoteInvoice = invoiceRow ? { hostInvoiceUrl: invoiceRow.hostInvoiceUrl } : null;
      }
    }
  }

  const brief = await prisma.webBrief.findUnique({ where: { clientId: resolved.clientId } });
  const wantsEdit = searchParams.edit === '1';

  if (brief?.status === 'submitted' && !wantsEdit) {
    const pages = jsonToStringArray(brief.pagesNeeded);
    const integrations = jsonToStringArray(brief.integrationsNeeded);
    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Portal"
          title="Plataforma web profesional"
          description={`Brief enviado ${brief.submittedAt ? new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(brief.submittedAt) : ''}.`}
          actions={
            <Link href="/portal/web?edit=1" className="btn-ghost" data-testid="web-brief-edit-link">
              Editar respuestas
            </Link>
          }
        />
        {isQuotePending ? <WebQuoteCard webQuote={webQuote} invoice={webQuoteInvoice} /> : null}
        <div className="card space-y-4" data-testid="web-brief-summary">
          <SummaryRow label="Negocio" value={brief.businessName} />
          <SummaryRow label="Sector" value={brief.vertical} />
          <SummaryRow
            label="Objetivo"
            value={brief.goal ? (GOAL_LABELS[brief.goal as (typeof GOAL_OPTIONS)[number]] ?? brief.goal) : null}
          />
          <SummaryRow label="Público objetivo" value={brief.targetAudience} />
          <SummaryRow
            label="Marca existente"
            value={brief.hasExistingBrand === null ? null : brief.hasExistingBrand ? 'Sí' : 'No'}
          />
          <SummaryRow label="Notas de marca" value={brief.brandAssetsNote} />
          <SummaryRow label="Páginas" value={pages.length > 0 ? pages.join(', ') : null} />
          <SummaryRow label="Otras páginas" value={brief.otherPagesNote} />
          <SummaryRow
            label="Textos"
            value={
              brief.contentProvidedBy
                ? (CONTENT_PROVIDED_BY_LABELS[brief.contentProvidedBy as (typeof CONTENT_PROVIDED_BY_OPTIONS)[number]] ?? brief.contentProvidedBy)
                : null
            }
          />
          <SummaryRow label="Dominio deseado" value={brief.desiredDomain} />
          <SummaryRow label="Referencias" value={brief.referenceWebsites} />
          <SummaryRow label="Integraciones" value={integrations.length > 0 ? integrations.join(', ') : null} />
          <SummaryRow label="Otras integraciones" value={brief.otherIntegrationsNote} />
          <SummaryRow label="Notas adicionales" value={brief.additionalNotes} />
        </div>
        <p className="text-sm text-kairikos-muted">
          ¿Necesitás cambiar algo que no está en este formulario?{' '}
          <Link href="/portal/support" className="underline hover:text-kairikos-text">
            Escribinos a soporte
          </Link>
          .
        </p>
      </div>
    );
  }

  const initial: Partial<WebBriefFormValues> | null = brief
    ? {
        businessName: brief.businessName ?? '',
        vertical: brief.vertical ?? '',
        goal: brief.goal ?? '',
        targetAudience: brief.targetAudience ?? '',
        hasExistingBrand: brief.hasExistingBrand,
        brandAssetsNote: brief.brandAssetsNote ?? '',
        pagesNeeded: jsonToStringArray(brief.pagesNeeded),
        otherPagesNote: brief.otherPagesNote ?? '',
        contentProvidedBy: brief.contentProvidedBy ?? '',
        desiredDomain: brief.desiredDomain ?? '',
        referenceWebsites: brief.referenceWebsites ?? '',
        integrationsNeeded: jsonToStringArray(brief.integrationsNeeded),
        otherIntegrationsNote: brief.otherIntegrationsNote ?? '',
        additionalNotes: brief.additionalNotes ?? '',
      }
    : null;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Portal"
        title="Plataforma web profesional"
        description="Contanos sobre tu negocio para que empecemos a diseñar tu sitio."
      />
      {isQuotePending ? <WebQuoteCard webQuote={webQuote} invoice={webQuoteInvoice} /> : null}
      <WebBriefForm initial={initial} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{value}</p>
    </div>
  );
}
