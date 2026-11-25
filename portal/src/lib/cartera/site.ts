import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { serviceState } from '../villas/exit-rules';
import { assignSiteToNewContract } from '../client-site';

// =============================================================================
// Cartera de Signature inmobiliaria — el sitio de la cartera y quién lo ve.
//
// Calca lib/villas/rental.ts (portal #405): producto propio que activa el
// operador, tres búsquedas según quién pregunta, y la baja con plazo de gracia
// de lib/villas/exit-rules.ts —las reglas son las mismas y son puras, así que
// se reutilizan en vez de copiarlas—. Especificación: docs/fase1-cartera.md
// del repositorio kairikos-signature-inmobiliaria.
// =============================================================================

export type Db = PrismaClient | Prisma.TransactionClient;

export const CARTERA_PRODUCT_CODE = 'cartera';

const FEED_TOKEN_RE = /^car_[A-Za-z0-9_-]{10,60}$/;

/** car_… para el feed; cbs_… para el secreto de publicación. 144 bits. */
export function generateCarteraToken(prefix: 'car' | 'cbs'): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

export function isFeedTokenShape(token: string): boolean {
  return FEED_TOKEN_RE.test(token);
}

/** El secreto de publicación se guarda solo como hash. Tiene 144 bits de
 *  azar: un SHA-256 sin sal basta (no es una contraseña que adivinar). */
export function hashBuildSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Para el aviso del build (PR 4): comparación en tiempo constante. */
export function verifyBuildSecret(secret: string, storedHash: string | null): boolean {
  if (!storedHash || !secret) return false;
  const a = Buffer.from(hashBuildSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CarteraAuditInput {
  siteId: string;
  clientId: string;
  entity: 'site' | 'home' | 'photo' | 'enquiry' | 'build' | 'export';
  entityId: string;
  action: string;
  /** 'client:<id>' | 'operator:<id>' | 'system' | 'buyer' */
  actor: string;
  /** Sin datos personales ni secretos: nunca un token ni su hash. */
  metadata?: Prisma.InputJsonValue;
}

export async function auditCartera(db: Db, input: CarteraAuditInput): Promise<void> {
  await db.carteraAudit.create({
    data: {
      siteId: input.siteId,
      clientId: input.clientId,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      actor: input.actor,
      metadata: input.metadata ?? {},
    },
  });
}

// --- Las tres búsquedas -------------------------------------------------------

/** El sitio por el token del feed, solo con la contratación ACTIVA: una
 *  agencia en pausa o de baja deja de alimentar builds nuevos, y su web se
 *  queda con la última cartera publicada. */
export async function findSiteByFeedToken(db: Db, token: string) {
  if (!isFeedTokenShape(token)) return null;
  return db.carteraSite.findFirst({
    where: { feedToken: token, clientProduct: { status: 'active', product: { code: CARTERA_PRODUCT_CODE } } },
  });
}

/** El sitio por el token del feed para el AVISO de una publicación (PR 4),
 *  sea cual sea el estado de la contratación: una publicación lanzada justo
 *  antes de una pausa o una baja tiene que poder contar cómo acabó. Lo que
 *  autentica el aviso es el secreto de publicación, no el token. */
export async function findSiteForBuildNotice(db: Db, token: string) {
  if (!isFeedTokenShape(token)) return null;
  return db.carteraSite.findFirst({
    where: { feedToken: token, clientProduct: { product: { code: CARTERA_PRODUCT_CODE } } },
    select: { id: true, clientId: true, siteUrl: true, githubRepo: true, buildSecretHash: true },
  });
}

/** El sitio del cliente para ESCRIBIR: activo o en pausa. Una contratación
 *  por cliente (no es multi-instancia), así que no hay que elegir. */
export async function findSiteForClient(db: Db, clientId: string) {
  return db.carteraSite.findFirst({
    where: { clientId, clientProduct: { status: { in: ['active', 'paused'] }, product: { code: CARTERA_PRODUCT_CODE } } },
  });
}

/**
 * El sitio del cliente para LEER y EXPORTAR, también dado de baja dentro del
 * plazo de gracia. Las rutas que escriben usan findSiteForClient: durante la
 * baja el panel es de solo lectura.
 */
export async function findSiteForOwner(db: Db, clientId: string, now: Date = new Date()) {
  const site = await db.carteraSite.findFirst({
    where: { clientId, clientProduct: { product: { code: CARTERA_PRODUCT_CODE } } },
    include: { clientProduct: { select: { status: true, cancelledAt: true, changedAt: true } } },
  });
  if (!site) return null;
  const exit = serviceState(site.clientProduct, site.exitNotifiedAt, now);
  if (exit.state === 'closed') return null;
  return { site, ...exit };
}

// --- Alta del operador --------------------------------------------------------

export type ActivateCarteraResult =
  | { ok: true; siteId: string; clientProductId: string; created: boolean; feedToken: string | null }
  | { ok: false; error: 'client_not_found' | 'product_missing' };

/**
 * Alta del módulo por el operador (no hay autoservicio: va dentro de un
 * presupuesto de Signature). Idempotente: si ya existe, la devuelve; si había
 * una contratación cancelada, la reactiva con UPDATE —el índice parcial único
 * de ClientProduct no deja otra fila para el mismo producto—.
 *
 * El token del feed solo se devuelve al crearse (`feedToken`); en una segunda
 * llamada sale null y, si se perdió, se regenera con el PATCH del sitio.
 */
export async function activateCartera(
  db: Prisma.TransactionClient,
  input: { clientId: string; operatorId: string },
): Promise<ActivateCarteraResult> {
  const [client, product] = await Promise.all([
    db.chatbotClient.findUnique({ where: { id: input.clientId }, select: { id: true, tenantId: true } }),
    db.product.findFirst({ where: { code: CARTERA_PRODUCT_CODE, isActive: true }, select: { id: true } }),
  ]);
  if (!client) return { ok: false, error: 'client_not_found' };
  if (!product) return { ok: false, error: 'product_missing' };

  const actorId = `operator:${input.operatorId}`;
  let contract = await db.clientProduct.findFirst({
    where: { clientId: client.id, productId: product.id },
    select: { id: true, status: true },
  });
  if (!contract) {
    contract = await db.clientProduct.create({
      data: { clientId: client.id, productId: product.id, tenantId: client.tenantId, status: 'active', createdBy: actorId, onboardingState: 'live' },
      select: { id: true, status: true },
    });
    await db.clientProductAudit.create({
      data: { clientProductId: contract.id, clientId: client.id, productId: product.id, tenantId: client.tenantId, action: 'cartera_activated', statusBefore: null, statusAfter: 'active', actorId },
    });
  } else if (contract.status !== 'active') {
    await db.clientProduct.update({ where: { id: contract.id }, data: { status: 'active', cancelledAt: null, changedBy: actorId, changedAt: new Date() } });
    await db.clientProductAudit.create({
      data: { clientProductId: contract.id, clientId: client.id, productId: product.id, tenantId: client.tenantId, action: 'cartera_reactivated', statusBefore: contract.status, statusAfter: 'active', actorId },
    });
  }

  // El negocio al que pertenece la contratación, como en cualquier alta de
  // operador (lib/client-product-activation.ts). Idempotente.
  await assignSiteToNewContract(db, { clientId: client.id, tenantId: client.tenantId, clientProductId: contract.id, productCode: CARTERA_PRODUCT_CODE });

  const s = await ensureCarteraSiteForContract(db, { clientProductId: contract.id, clientId: client.id, tenantId: client.tenantId, actorId });
  return { ok: true, siteId: s.siteId, clientProductId: contract.id, created: s.created, feedToken: s.feedToken };
}

/**
 * El CarteraSite de una contratación 'cartera' ya activa: lo crea vacío, con
 * su token del feed, si no existe; si existe y estaba en el plazo de gracia de
 * una baja, anula la baja. La usan las dos altas de operador —la de
 * POST /api/admin/portal/cartera y la de «Productos contratados»
 * (activateClientProductForOperator)—, para que las dos dejen el módulo igual.
 *
 * El secreto de publicación NO se crea aquí: solo existe en claro cuando se
 * genera, y por esta vía nadie lo vería. El operador lo genera con el PATCH al
 * configurar el repositorio de GitHub.
 */
export async function ensureCarteraSiteForContract(
  db: Prisma.TransactionClient,
  input: { clientProductId: string; clientId: string; tenantId: string | null; actorId: string },
): Promise<{ siteId: string; created: boolean; feedToken: string | null }> {
  const existing = await db.carteraSite.findUnique({ where: { clientProductId: input.clientProductId }, select: { id: true, exitNotifiedAt: true } });
  if (existing) {
    // Vuelve dentro del plazo de gracia: la baja queda anulada y, si algún
    // día se da de baja otra vez, el aviso tiene que salir de nuevo.
    if (existing.exitNotifiedAt) await db.carteraSite.update({ where: { id: existing.id }, data: { exitNotifiedAt: null } });
    return { siteId: existing.id, created: false, feedToken: null };
  }

  const feedToken = generateCarteraToken('car');
  const site = await db.carteraSite.create({
    data: { clientProductId: input.clientProductId, clientId: input.clientId, tenantId: input.tenantId, feedToken },
    select: { id: true },
  });
  await auditCartera(db, { siteId: site.id, clientId: input.clientId, entity: 'site', entityId: site.id, action: 'created', actor: input.actorId });
  return { siteId: site.id, created: true, feedToken };
}

// --- El feed ------------------------------------------------------------------

/** Las casas de un sitio con sus fotos, para lib/cartera/feed.ts. Los
 *  borradores ya se quedan fuera aquí; los errores los mira buildFeed. */
export async function loadFeedRows(db: Db, siteId: string) {
  return db.carteraHome.findMany({
    where: { siteId, status: { not: 'borrador' } },
    select: {
      ref: true,
      operation: true,
      status: true,
      data: true,
      errors: true,
      photos: { select: { id: true, width: true, height: true, position: true, alt: true }, orderBy: { position: 'asc' } },
      panos: { select: { id: true, width: true, height: true, position: true }, orderBy: { position: 'asc' } },
    },
    orderBy: { ref: 'asc' },
  });
}
