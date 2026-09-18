import { redirect } from 'next/navigation';
import Link from 'next/link';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { listContractedInstances } from '@/lib/client-product-access';
import { SeoPageBody } from './seo-page';

export const dynamic = 'force-dynamic';

// =============================================================================
// Fase 2 multi-instancia — el índice de SEO.
//
// Con UNA contratación (el caso de todos los clientes de hoy) esta página se
// comporta exactamente como antes: pinta el cuerpo directamente, sin
// redirección ni selector. Nadie ve un desplegable de un solo elemento.
//
// Con varias, ofrece elegir web. No redirige a la primera: cuál es "la
// primera" no significa nada para el cliente, y aterrizar en la web
// equivocada para descubrirlo es peor que preguntar.
//
// Mismo reparto que /portal/web, que lleva así desde septiembre de 2026.
// =============================================================================

export default async function PortalSeoIndexPage({
  searchParams,
}: {
  searchParams?: Record<string, string | undefined>;
}) {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) redirect('/portal/login?next=/portal/seo');

  const instances =
    isDatabaseConfigured && resolved.source === 'database'
      ? (await listContractedInstances(prisma, resolved.clientId)).filter((i) => i.code === 'seo')
      : [];

  // 0 contrataciones cae también aquí: el cuerpo enseña la ficha de venta.
  if (instances.length <= 1) {
    return <SeoPageBody searchParams={searchParams} />;
  }

  const sites = await prisma.seoProfile.findMany({
    where: { clientProductId: { in: instances.map((i) => i.clientProductId) } },
    select: { clientProductId: true, siteUrl: true },
  });
  const siteByProduct = new Map(sites.map((s) => [s.clientProductId, s.siteUrl]));

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">SEO con IA</h1>
        <p className="text-sm text-kairikos-muted">Elige la web que quieres ver.</p>
      </header>
      <ul className="space-y-2">
        {instances.map((instance) => (
          <li key={instance.clientProductId}>
            <Link
              href={`/portal/seo/${instance.clientProductId}`}
              className="flex items-center justify-between rounded-xl border border-kairikos-border p-4 hover:border-kairikos-accent"
              data-testid="seo-site-option"
            >
              <span className="font-medium">
                {siteByProduct.get(instance.clientProductId) || 'Web sin dirección todavía'}
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
