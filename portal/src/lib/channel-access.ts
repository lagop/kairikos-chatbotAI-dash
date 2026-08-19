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
 */
export async function getAllowedChannelsForClient(
  prisma: PrismaClient,
  clientId: string,
): Promise<ChannelCode[]> {
  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId, status: 'active', product: { code: CHATBOT_PRODUCT_CODE } },
    select: { product: { select: { features: true } } },
  });
  if (!clientProduct) return [];

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
): Promise<boolean> {
  const allowed = await getAllowedChannelsForClient(prisma, clientId);
  return allowed.includes(channel);
}
