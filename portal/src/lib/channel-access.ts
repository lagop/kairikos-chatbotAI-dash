import type { PrismaClient } from '@prisma/client';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';

// =============================================================================
// WP: conexión de canales — qué canales de chatbot puede conectar un
// cliente depende de su tier ('starter' | 'pro' | 'premium'), no solo de
// si tiene el producto 'chatbot' activo. isProductContracted() (see
// client-product-access.ts) confirms the product is active; this module
// answers the finer-grained question of WHICH channels that tier
// unlocks, read from Product.features.channels — a column that has
// existed since WP-12 but was never populated until prisma/seed.ts's
// PRODUCT_CATALOG entries for 'chatbot' started setting it.
//
// Reference mapping (seed.ts), not fixed in code:
//   starter → ['web']
//   pro     → ['web', 'telegram', 'whatsapp']
//   premium → ['web', 'telegram', 'whatsapp', 'messenger', 'instagram']
// =============================================================================

export type ChannelCode = 'web' | 'telegram' | 'whatsapp' | 'messenger' | 'instagram';

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<ChannelCode>([
  'web',
  'telegram',
  'whatsapp',
  'messenger',
  'instagram',
]);

function isChannelCode(value: unknown): value is ChannelCode {
  return typeof value === 'string' && KNOWN_CHANNELS.has(value);
}

/**
 * Resolves the set of channels a client's currently-active chatbot tier
 * unlocks. Returns an empty array if the client has no active 'chatbot'
 * ClientProduct, or if that tier's Product.features.channels is missing
 * or malformed (fails closed — a misconfigured catalog row should block
 * connecting channels, not silently allow everything).
 *
 * Fase 4 multi-instancia — los canales los da la TARIFA de un chatbot
 * concreto, y un cliente puede tener dos de tarifas distintas: un Starter sin
 * WhatsApp para un negocio y un Premium con WhatsApp para otro. Esto hacía
 * findFirst SIN orden, así que con dos chatbots podía leer la tarifa del
 * Premium y dejar conectar WhatsApp al Starter. No era un fallo de datos sino
 * de plan: el cliente obtenía un canal que no había pagado para ese negocio.
 *
 * Con `clientProductId` se mira esa contratación. Sin él se mira la única que
 * haya; con dos y sin decir cuál se devuelve [] — cerrar, igual que ya hacía
 * esta función con un catálogo mal configurado.
 */
export async function getAllowedChannelsForClient(
  prisma: PrismaClient,
  clientId: string,
  clientProductId?: string | null,
): Promise<ChannelCode[]> {
  const rows = await prisma.clientProduct.findMany({
    where: {
      ...(clientProductId ? { id: clientProductId } : {}),
      clientId,
      status: 'active',
      product: { code: CHATBOT_PRODUCT_CODE },
    },
    select: { product: { select: { features: true } } },
    orderBy: { subscribedAt: 'asc' },
    take: 2,
  });
  if (rows.length !== 1) return [];
  const clientProduct = rows[0];

  const features = clientProduct.product.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return [];

  const channels = (features as Record<string, unknown>).channels;
  if (!Array.isArray(channels)) return [];

  return channels.filter(isChannelCode);
}

/**
 * Convenience check for a single channel — every channel-connect route
 * (Telegram connect, Meta OAuth start, Web enable) gates on this before
 * allowing the action. 403s as 'channel_not_in_plan' when false.
 */
export async function isChannelAllowedForClient(
  prisma: PrismaClient,
  clientId: string,
  channel: ChannelCode,
  /** El chatbot al que se conecta el canal. Las rutas de conexión lo pasan
   *  siempre: la tarifa que cuenta es la de ESE chatbot. */
  clientProductId?: string | null,
): Promise<boolean> {
  const allowed = await getAllowedChannelsForClient(prisma, clientId, clientProductId);
  return allowed.includes(channel);
}
