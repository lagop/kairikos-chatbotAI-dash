import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { readLatestStepsForClient } from '@/lib/wizard-tier-prisma';
import { parseStepNumber, CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { getProductCatalog } from '@/lib/catalogs';
import { listContractedProducts } from '@/lib/client-product-access';
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
// =============================================================================

export const dynamic = 'force-dynamic';

export default async function WizardIndexPage({
  searchParams,
}: {
  searchParams: { step?: string };
}) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/wizard');
  }

  const queryStep = searchParams.step;
  if (queryStep) {
    try {
      parseStepNumber(queryStep);
      redirect(`/portal/wizard/${CHATBOT_PRODUCT_CODE}/${queryStep}`);
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

  const contracted = await listContractedProducts(prisma, resolved.clientId);

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

  const cards = await Promise.all(
    contracted.map(async (product) => {
      const catalog = getProductCatalog(product.code);
      if (catalog.stepKeys.length === 0) {
        return { code: product.code, label: catalog.label, available: false as const };
      }
      const savedRows = await readLatestStepsForClient(prisma, resolved.clientId, product.code);
      const activeKeys = new Set(
        savedRows.filter((r) => r.latest?.activeForBot).map((r) => r.stepKey),
      );
      const doneCount = catalog.requiredStepKeys.filter((k) => activeKeys.has(k)).length;
      const percent = catalog.requiredStepKeys.length
        ? Math.round((doneCount / catalog.requiredStepKeys.length) * 100)
        : 0;
      return { code: product.code, label: catalog.label, available: true as const, percent };
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
              key={card.code}
              href={`/portal/wizard/${card.code}`}
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
            <div key={card.code} className="card space-y-2 opacity-60">
              <p className="text-lg font-semibold">{card.label}</p>
              <p className="text-sm text-kairikos-muted">Próximamente</p>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
