import { LlamadasPageBody } from './llamadas-page';

export const dynamic = 'force-dynamic';

// =============================================================================
// Fase 3 multi-instancia — el índice de Recall.
//
// Fina a propósito: el cuerpo ya sabe qué hacer cuando hay varias líneas y
// ninguna elegida (devuelve `pick_line` y pinta el selector). Con una sola
// —el caso de todos los clientes de hoy— la página es idéntica a la de antes.
// =============================================================================

export default async function PortalLlamadasIndexPage({
  searchParams,
}: {
  searchParams?: { mes?: string; p?: string; connected?: string; connect_error?: string };
}) {
  return <LlamadasPageBody searchParams={searchParams} />;
}
