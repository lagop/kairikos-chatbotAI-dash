import { SeoPageBody } from '../seo-page';

export const dynamic = 'force-dynamic';

// =============================================================================
// Fase 2 multi-instancia — una web concreta.
//
// Fina a propósito: toda la lógica vive en SeoPageBody, compartida con el
// índice. El id de la URL no autoriza nada por sí solo — SeoPageBody lo pasa
// por resolveContractedInstance, que lo fija al cliente de la sesión y al
// producto 'seo', así que el id de otro cliente no resuelve y la página
// enseña la ficha de venta en vez de datos ajenos.
// =============================================================================

export default async function PortalSeoInstancePage({
  params,
  searchParams,
}: {
  params: { clientProductId: string };
  searchParams?: Record<string, string | undefined>;
}) {
  return <SeoPageBody clientProductId={params.clientProductId} searchParams={searchParams} />;
}
