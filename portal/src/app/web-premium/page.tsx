import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PremiumQuoter } from '@/components/public/PremiumQuoter';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { loadResolvedQuoter } from '@/lib/premium-quoter';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

// =============================================================================
// /web-premium (09/11/2026) — el presupuestador de Kairikos Web Premium.
//
// Pública y sin sesión, como /calculadora; cae fuera del matcher de
// src/middleware.ts. Es la vista previa del operador y la versión suelta: en
// kairikos.com el mismo componente va insertado en la página por un script
// (src/embed/presupuestador.tsx), sin marco. Hasta el 10/11/2026 iba en un
// marco, y tenía su propio scroll dentro del de la página.
//
// Nace apagada: mientras `config.published` sea false solo la ve un operador.
// Los buscadores no la indexan; la página que debe posicionar es la de
// kairikos.com, que es a la que apunta el canónico.
// =============================================================================

export const metadata: Metadata = {
  title: 'Presupuestador · Kairikos Web Premium',
  description: 'Elige tu sector, responde unas preguntas y ve tu presupuesto en tiempo real, con el desglose de cada pieza.',
  alternates: { canonical: 'https://kairikos.com/web-premium/' },
  robots: { index: false, follow: false },
};

export default async function WebPremiumPage() {
  if (!isDatabaseConfigured) notFound();
  const loaded = await loadResolvedQuoter(prisma);
  if (!loaded.ok) notFound();

  let preview = false;
  if (!loaded.quoter.config.published) {
    const session = await getSession();
    if (!session.isOperator) notFound();
    preview = true;
  }

  return (
    <>
      {/* Solo esta página usa la serif: no merece ir en el layout de todo el portal. */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/fuentes/instrument-serif/fuentes.css" />
      <PremiumQuoter quoter={loaded.quoter} embedded={false} preview={preview} />
    </>
  );
}
