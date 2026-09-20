import 'server-only';
import type { PrismaClient, ChatWebEmbed } from '@prisma/client';

// =============================================================================
// Fase 4 multi-instancia — el widget web de UN chatbot.
//
// Las rutas de apariencia (PATCH /api/portal/channels/web) y de desactivar
// (POST /api/portal/channels/web/disable) resolvían el widget con
// findFirst({ clientId }). Con un chatbot por cliente era exacto; con dos,
// desactivar el widget de un negocio habría desactivado el del otro, o
// cambiado el color del equivocado. Ningún test de rutas lo veía, porque
// estas dos no consultan la contratación: van directas al widget.
//
// Esto NO añade una comprobación de contratación que antes no existía — un
// cliente que canceló el chatbot puede seguir apagando su widget. Solo
// desambigua: con `clientProductId` busca el widget de ese chatbot; sin él,
// el único que haya; con varios y sin decir cuál, se niega.
// =============================================================================

export type WebEmbedResolution =
  | { ok: true; embed: ChatWebEmbed }
  | { ok: false; reason: 'not_found' | 'ambiguous' };

export async function resolveClientWebEmbed(
  prisma: PrismaClient,
  clientId: string,
  clientProductId?: string | null,
): Promise<WebEmbedResolution> {
  const rows = await prisma.chatWebEmbed.findMany({
    where: { clientId, ...(clientProductId ? { clientProductId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 2,
  });
  if (rows.length === 0) return { ok: false, reason: 'not_found' };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, embed: rows[0] };
}
