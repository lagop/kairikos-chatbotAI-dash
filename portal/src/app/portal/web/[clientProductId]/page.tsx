import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { WEB_ACCESSIBLE_STATUSES } from '@/lib/client-product-access';
import { resolveWebQuoteContext } from '@/lib/web-quotes';
import { PageHeading } from '@/components/portal/PageHeading';
import { WebBriefForm, type WebBriefFormValues } from '@/components/portal/WebBriefForm';
import { WebQuoteCard, type ClientWebQuoteData, type ClientWebQuoteInvoiceData } from '@/components/portal/WebQuoteCard';
import { GOAL_LABELS, CONTENT_PROVIDED_BY_LABELS, type GOAL_OPTIONS, type CONTENT_PROVIDED_BY_OPTIONS } from '@/lib/web-brief-schema';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plataforma web profesional · Portal Kairikos',
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-XX — one project's detail page: brief + quote status + accept flow.
// Moved out of /portal/web (now a 0/1/N resolver — see that file) so a
// client with multiple 'web' projects (see ClientProduct's schema
// comment) gets a real, bookmarkable URL per project instead of all of
// them fighting over a single /portal/web.
// =============================================================================

function jsonToStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export default async function PortalWebProjectPage({
  params,
  searchParams,
}: {
  params: { clientProductId: string };
  searchParams: { edit?: string };
}) {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect(`/portal/login?next=/portal/web/${params.clientProductId}`);
  }
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    notFound();
  }

  const webClientProduct = await prisma.clientProduct.findFirst({
    where: { id: params.clientProductId, clientId: resolved.clientId, product: { code: 'web' } },
    select: { id: true, status: true },
  });
  if (!webClientProduct || !WEB_ACCESSIBLE_STATUSES.includes(webClientProduct.status)) {
    notFound();
  }

  // WebQuote Fase 4 — while the 'web' ClientProduct is still in
  // 'quote_pending' (pre-payment), show the quote status above the
  // brief. Once it flips to 'active', this stays null and the page
  // behaves exactly as before.
  let isQuotePending = false;
  let webQuote: ClientWebQuoteData | null = null;
  let webQuoteInvoice: ClientWebQuoteInvoiceData | null = null;
  const context = await resolveWebQuoteContext(prisma, webClientProduct.id);
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

  const brief = await prisma.webBrief.findUnique({ where: { clientProductId: webClientProduct.id } });
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
            <Link href={`/portal/web/${webClientProduct.id}?edit=1`} className="btn-ghost" data-testid="web-brief-edit-link">
              Editar respuestas
            </Link>
          }
        />
        {isQuotePending ? <WebQuoteCard clientProductId={webClientProduct.id} webQuote={webQuote} invoice={webQuoteInvoice} /> : null}
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
      {isQuotePending ? <WebQuoteCard clientProductId={webClientProduct.id} webQuote={webQuote} invoice={webQuoteInvoice} /> : null}
      <WebBriefForm clientProductId={webClientProduct.id} initial={initial} />
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
