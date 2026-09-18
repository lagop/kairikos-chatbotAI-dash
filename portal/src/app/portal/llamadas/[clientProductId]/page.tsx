import { LlamadasPageBody } from '../llamadas-page';

export const dynamic = 'force-dynamic';

// =============================================================================
// Fase 3 multi-instancia — una línea concreta.
//
// El id de la URL no autoriza nada por sí solo: loadRecallClientView lo usa
// como FILTRO sobre las suscripciones de este cliente, así que el id de otro
// cliente no devuelve nada y la página cae en "no contratado" en vez de
// enseñar los recados de un desconocido.
// =============================================================================

export default async function PortalLlamadasLinePage({
  params,
  searchParams,
}: {
  params: { clientProductId: string };
  searchParams?: { mes?: string; p?: string; connected?: string; connect_error?: string };
}) {
  return <LlamadasPageBody clientProductId={params.clientProductId} searchParams={searchParams} />;
}
