import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import { parseStepNumber, CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { getProductCatalog } from '@/lib/catalogs';
import { listContractedInstances } from '@/lib/client-product-access';
import { withChatbot } from '@/lib/wizard-url';
import { PageHeading } from '@/components/portal/PageHeading';

// =============================================================================
// WP-16 — /portal/wizard is now the product selector: it lists every
// product the client has contracted (ClientProduct.status='active') with
// its own configuration progress, and skips straight to the wizard when
// there is only one — matching the pre-WP-16 behavior of landing directly
// on Step 1, just generalized to "the client's only product" instead of
// "the client's only product, which was always chatbot".
//
// `?step=N` is kept for backward compatibility: src/lib/wizard-recovery-
// email.ts builds `${portalUrl}/portal/wizard?step=${lastStepKey}` for the
// wizard-abandoned recovery email (chatbot-only flow — WP-14 scoped that
// job to the chatbot product), so this route still has to honor it.
//
// Fase 4 multi-instancia — el selector es ahora de CONTRATACIONES, no de
// productos: un cliente con dos chatbots ve dos tarjetas, cada una con el
// nombre de su negocio y su propio porcentaje, y cada enlace lleva su
// `?clientProductId=`. Con una sola contratación se salta directo al
// asistente, igual que antes y sin parámetro — la URL es la de siempre.
// =============================================================================

export const dynamic = 'force-dynamic';

export default async function WizardIndexPage({
  searchParams,
}: {
  searchParams: { step?: string; clientProductId?: string };
}) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/wizard');
  }

  const queryStep = searchParams.step;
  if (queryStep) {
    try {
      parseStepNumber(queryStep);
      redirect(withChatbot(`/portal/wizard/${CHATBOT_PRODUCT_CODE}/${queryStep}`, searchParams.clientProductId));
    } catch {
      redirect('/portal/wizard');
    }
  }

  // See the matching comment in wizard/[product]/[step]/page.tsx —
  // resolved.source === 'database' means this is a real, authenticated
  // client, which must take priority over the isPortalDevMock() heuristic.
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    // Dev-mock fixtures are chatbot-only; there is no multi-product
    // selector to show.
    redirect(`/portal/wizard/${CHATBOT_PRODUCT_CODE}`);
  }

  const contracted = await listContractedInstances(prisma, resolved.clientId);

  if (contracted.length === 0) {
    // Defensive fallback: every client should have a 'chatbot'
    // ClientProduct row from signup (see api/public/intake/route.ts).
    // A client with none yet (data drift) still lands on the chatbot
    // wizard rather than a dead end.
    redirect(`/portal/wizard/${CHATBOT_PRODUCT_CODE}`);
  }

  if (contracted.length === 1) {
    redirect(`/portal/wizard/${contracted[0].code}`);
  }

  // Los nombres de negocio, para distinguir dos contrataciones del mismo
  // producto. Solo hacen falta cuando el código se repite.
  const repeated = new Set(
    contracted.map((c) => c.code).filter((code, i, all) => all.indexOf(code) !== i),
  );
  const siteIds = contracted.filter((c) => repeated.has(c.code) && c.clientSiteId).map((c) => c.clientSiteId as string);
  const sites = siteIds.length
    ? await prisma.clientSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })
    : [];
  const siteName = new Map(sites.map((site) => [site.id, site.name]));

  // Los productos sin asistente todavía siguen saliendo una vez por código:
  // no hay nada que elegir dentro de "Próximamente".
  const seenWithoutWizard = new Set<string>();
  const instances = contracted.filter((c) => {
    if (getProductCatalog(c.code).stepKeys.length > 0) return true;
    if (seenWithoutWizard.has(c.code)) return false;
    seenWithoutWizard.add(c.code);
    return true;
  });

  const cards = await Promise.all(
    instances.map(async (product) => {
      const catalog = getProductCatalog(product.code);
      const key = product.clientProductId;
      if (catalog.stepKeys.length === 0) {
        return { key, code: product.code, label: catalog.label, available: false as const };
      }
      const isRepeated = repeated.has(product.code);
      const label = isRepeated
        ? `${catalog.label} — ${(product.clientSiteId && siteName.get(product.clientSiteId)) || 'sin nombre de negocio'}`
        : catalog.label;
      const href = withChatbot(`/portal/wizard/${product.code}`, isRepeated ? product.clientProductId : null);
      const savedRows = await readLatestStepsForClient(
        prisma,
        resolved.clientId,
        product.code,
        product.clientProductId,
      );
      const activeKeys = new Set(
        savedRows.filter((r) => r.latest?.activeForBot).map((r) => r.stepKey),
      );
      const doneCount = catalog.requiredStepKeys.filter((k) => activeKeys.has(k)).length;
      const percent = catalog.requiredStepKeys.length
        ? Math.round((doneCount / catalog.requiredStepKeys.length) * 100)
        : 0;
      return { key, code: product.code, label, href, available: true as const, percent };
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Configuración"
        title="Elige qué producto configurar"
        description="Tienes más de un producto contratado. Selecciona cuál quieres configurar o continuar."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) =>
          card.available ? (
            <Link
              key={card.key}
              href={card.href}
              className="card block space-y-2 transition hover:border-kairikos-accent/40"
            >
              <p className="text-lg font-semibold">{card.label}</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-kairikos-border/60">
                <div
                  className="h-full rounded-full bg-kairikos-accent"
                  style={{ width: `${card.percent}%` }}
                />
              </div>
              <p className="text-sm text-kairikos-muted">{card.percent}% configurado</p>
            </Link>
          ) : (
            <div key={card.key} className="card space-y-2 opacity-60">
              <p className="text-lg font-semibold">{card.label}</p>
              <p className="text-sm text-kairikos-muted">Próximamente</p>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
