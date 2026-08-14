import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { WebBriefForm, type WebBriefFormValues } from '@/components/portal/WebBriefForm';
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
      ? await isProductContracted(prisma, resolved.clientId, 'web')
      : false;

  if (!hasWeb) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title="Plataforma web profesional" />
        <EmptyState
          title="No incluido en tu plan actual"
          description="Este producto no está contratado en tu cuenta. Puedes añadirlo desde el catálogo de autoservicio."
          action={
            <Link href="/portal/productos" className="btn-primary" data-testid="web-brief-add-link">
              Ver productos disponibles
            </Link>
          }
        />
      </div>
    );
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
