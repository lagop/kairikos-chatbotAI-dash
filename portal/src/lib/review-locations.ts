import 'server-only';
import type { PrismaClient, GoogleBusinessConnection } from '@prisma/client';

// =============================================================================
// Fase 3 — varias ubicaciones por cliente en el producto 'reseñas'.
//
// El esquema ya lo permitía desde siempre: GoogleBusinessConnection está
// claveada @@unique([clientId, locationId]), y GoogleReview y
// ReviewRequestCampaign cuelgan de connectionId, no del cliente. Lo que
// faltaba no era el modelo, sino dos cosas:
//
//   1. El callback de OAuth rechazaba a propósito una cuenta de Google con
//      más de un local (`multiple_locations_unsupported`), porque no había
//      dónde elegir y «silently picking the first risks managing the wrong
//      business's reviews». La puerta estaba cerrada con razón.
//
//   2. Media docena de consultas resolvían la conexión con
//      findFirst({ clientId, status: 'active' }). Con dos locales eso pasa
//      a ser «el que devuelva Postgres primero»: el peor tipo de fallo,
//      porque parece funcionar.
//
// **El tope es por tarifa, no por local facturado.** Misma decisión que
// toma 'recall' con sus tres tarifas por tamaño de negocio: una factura
// variable es justo la ansiedad contra la que se vende este catálogo. Y va
// como constante y no en la base de datos por lo mismo que TIER_LEAD_CAP —
// es una decisión de producto, y quiere vivir donde se lee el código que
// la aplica.
// =============================================================================

/** Ubicaciones incluidas en cada tarifa de 'reviews'. Coincide con lo que
 *  se vende en prisma/seed.ts: una sola fuente de verdad, para que el tope
 *  que aplica el servidor no pueda separarse del que se cobró. */
export const TIER_LOCATION_CAP: Readonly<Record<string, number>> = Object.freeze({
  basic: 1,
  pro: 3,
  chain: 10,
});

/** Cuando la tarifa no se reconoce. Uno, nunca ilimitado: equivocarse por
 *  abajo hace que un cliente pida ayuda; equivocarse por arriba le regala
 *  un producto que no ha comprado y nadie se entera. */
export const DEFAULT_LOCATION_CAP = 1;

export function locationCapForTier(tier: string | null | undefined): number {
  if (!tier) return DEFAULT_LOCATION_CAP;
  return TIER_LOCATION_CAP[tier] ?? DEFAULT_LOCATION_CAP;
}

export interface LocationAllowance {
  cap: number;
  used: number;
  remaining: number;
  tier: string | null;
}

/**
 * Cuántos locales puede conectar todavía este cliente.
 *
 * Cuenta las conexiones que NO están revocadas: una conexión rota
 * ('needs_reconnect') sigue siendo un local suyo que hay que arreglar, no
 * un hueco libre. Solo desconectar de verdad libera sitio.
 */
export async function getLocationAllowance(
  prisma: PrismaClient,
  clientId: string,
): Promise<LocationAllowance> {
  const [product, used] = await Promise.all([
    prisma.clientProduct.findFirst({
      where: { clientId, status: 'active', product: { code: 'reviews' } },
      select: { product: { select: { tier: true } } },
    }),
    prisma.googleBusinessConnection.count({
      where: { clientId, status: { not: 'revoked' } },
    }),
  ]);

  const tier = product?.product.tier ?? null;
  const cap = locationCapForTier(tier);
  return { cap, used, remaining: Math.max(0, cap - used), tier };
}

export interface ReviewLocation {
  id: string;
  locationId: string;
  locationName: string;
  status: string;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  autoPublishReplies: boolean;
  reviewUrl: string | null;
}

/** Los locales del cliente, en orden estable. Se ordena por nombre y no por
 *  fecha de conexión para que el selector no se reordene bajo el dedo
 *  cuando una conexión se reconecta. */
export async function listReviewLocations(
  prisma: PrismaClient,
  clientId: string,
): Promise<ReviewLocation[]> {
  return prisma.googleBusinessConnection.findMany({
    where: { clientId, status: { not: 'revoked' } },
    orderBy: [{ locationName: 'asc' }, { locationId: 'asc' }],
    select: {
      id: true,
      locationId: true,
      locationName: true,
      status: true,
      lastSyncAt: true,
      lastSyncError: true,
      autoPublishReplies: true,
      reviewUrl: true,
    },
  });
}

/**
 * La conexión sobre la que actúa una petición del cliente.
 *
 * Sustituye a los `findFirst({ clientId, status: 'active' })` que había
 * repartidos por las rutas. La diferencia que importa: el `clientId` va
 * DENTRO de la consulta, así que un id de otro tenant simplemente no
 * existe, en vez de existir y estar prohibido — y con `connectionId` a
 * null se resuelve el único local que tenga, que es el caso de casi todos
 * los clientes y lo que mantiene compatibles a las rutas que no lo mandan.
 *
 * Devuelve null cuando hay VARIOS y no se ha dicho cuál: elegir uno por él
 * es exactamente lo que este trabajo viene a quitar.
 */
export async function resolveReviewConnection(
  prisma: PrismaClient,
  clientId: string,
  connectionId?: string | null,
): Promise<GoogleBusinessConnection | null> {
  if (connectionId) {
    return prisma.googleBusinessConnection.findFirst({
      where: { id: connectionId, clientId, status: 'active' },
    });
  }

  // Se piden DOS para poder distinguir «solo tiene uno» de «tiene varios»
  // sin contar la tabla entera.
  const active = await prisma.googleBusinessConnection.findMany({
    where: { clientId, status: 'active' },
    take: 2,
  });
  return active.length === 1 ? active[0] : null;
}
