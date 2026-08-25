import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { WEB_ACCESSIBLE_STATUSES } from '@/lib/client-product-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { RequestWebQuoteCard } from '@/components/portal/RequestWebQuoteCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plataforma web profesional',
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-XX — a client can have multiple independent 'web' projects (see
// ClientProduct's schema comment), each with its own brief/quote/detail
// page at /portal/web/[clientProductId]. This page is now purely a
// resolver: 0 projects → the pitch (unchanged); exactly 1 → redirect
// straight to that project's detail page (preserves today's UX for the
// ~100% of clients who have exactly one); 2+ → a simple picker list.
// =============================================================================

const STATUS_LABEL: Record<string, string> = {
  quote_pending: 'Presupuesto en curso',
  active: 'Activo',
  paused: 'Pausado',
};

export default async function PortalWebPage() {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/web');
  }

  const projects =
    isDatabaseConfigured && resolved.source === 'database'
      ? await prisma.clientProduct.findMany({
          where: { clientId: resolved.clientId, status: { in: WEB_ACCESSIBLE_STATUSES }, product: { code: 'web' } },
          orderBy: { subscribedAt: 'asc' },
          select: { id: true, status: true, webBrief: { select: { businessName: true } } },
        })
      : [];

  if (projects.length === 0) {
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

  if (projects.length === 1) {
    redirect(`/portal/web/${projects[0].id}`);
  }

  const hasInFlightRequest = projects.some((p) => p.status === 'quote_pending');

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Portal"
        title="Plataforma web profesional"
        description="Tienes varios proyectos web — elige uno para ver su detalle."
      />
      <ul className="space-y-3" data-testid="web-project-list">
        {projects.map((project, index) => (
          <li key={project.id}>
            <Link
              href={`/portal/web/${project.id}`}
              className="card flex items-center justify-between gap-3 transition hover:border-kairikos-accent/40"
              data-testid="web-project-row"
            >
              <span className="font-medium">{project.webBrief?.businessName || `Proyecto ${index + 1}`}</span>
              <span className="pill-muted" data-testid={`web-project-status-${project.id}`}>
                {STATUS_LABEL[project.status] ?? project.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {!hasInFlightRequest ? <RequestWebQuoteCard label="Solicitar otro proyecto" /> : null}
    </div>
  );
}
