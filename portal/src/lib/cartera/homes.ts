import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { auditCartera, type Db } from "./site";
import {
  canDeleteHome,
  computeHomeSave,
  initialHomeData,
  nextRef,
  validateHome,
  type HomeSaveInput,
} from "./home-rules";
import { removePhotoFiles } from "./photos";
import type { CarteraOperation } from "./types";

// =============================================================================
// Cartera — alta, edición y borrado de casas (PR 2). Las reglas viven en
// home-rules.ts, puras; aquí solo la base de datos, la auditoría y la marca de
// «hay cambios sin publicar» (pendingSince), que el cron de publicación del
// PR 4 leerá.
// =============================================================================

export type SiteForHomes = {
  id: string;
  clientId: string;
  salePrefix: string;
  rentPrefix: string;
  agents: Prisma.JsonValue;
};

/** CarteraSite.agents, leído con cuidado: [{ key, name }]. */
export function siteAgents(site: {
  agents: Prisma.JsonValue;
}): Array<{ key: string; name: string }> {
  if (!Array.isArray(site.agents)) return [];
  return site.agents.flatMap((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return [];
    const o = a as Record<string, unknown>;
    return typeof o.key === "string" && typeof o.name === "string"
      ? [{ key: o.key, name: o.name }]
      : [];
  });
}

/** Hay cambios que la web todavía no tiene. Se queda la fecha más antigua:
 *  el cron publica lo que lleva más tiempo esperando. */
export async function markPending(
  db: Db,
  siteId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.carteraSite.updateMany({
    where: { id: siteId, pendingSince: null },
    data: { pendingSince: now },
  });
}

export async function findOwnedHome(db: Db, siteId: string, homeId: string) {
  return db.carteraHome.findFirst({ where: { id: homeId, siteId } });
}

export type CreateHomeResult =
  | { ok: true; id: string; ref: string }
  | { ok: false; error: "refs_exhausted" };

/** Un borrador nuevo con su referencia. Dos altas a la vez pueden calcular la
 *  misma: el índice único (site_id, ref) para a la segunda y se reintenta, cada
 *  vez en una transacción nueva (en Postgres un error deja inservible la
 *  transacción en la que ocurre). */
export async function createHome(
  prisma: PrismaClient,
  site: SiteForHomes,
  operation: CarteraOperation,
  actor: string,
  now: Date = new Date(),
): Promise<CreateHomeResult> {
  const prefix = operation === "venta" ? site.salePrefix : site.rentPrefix;
  const agents = siteAgents(site);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.carteraHome.findMany({
      where: { siteId: site.id, ref: { startsWith: `${prefix}-` } },
      select: { ref: true },
    });
    const ref = nextRef(
      existing.map((h) => h.ref),
      prefix,
      operation,
    );
    if (!ref) return { ok: false, error: "refs_exhausted" };
    const data = initialHomeData(operation, { agents }, now);
    const errors = validateHome(
      operation,
      { ref, status: "borrador", data },
      { agents },
    );
    try {
      const id = await prisma.$transaction(async (db) => {
        const home = await db.carteraHome.create({
          data: {
            siteId: site.id,
            clientId: site.clientId,
            ref,
            operation,
            status: "borrador",
            data: data as Prisma.InputJsonValue,
            errors: errors.length
              ? (errors as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            updatedBy: actor,
          },
          select: { id: true },
        });
        await auditCartera(db, {
          siteId: site.id,
          clientId: site.clientId,
          entity: "home",
          entityId: home.id,
          action: "created",
          actor,
          metadata: { ref, operation },
        });
        return home.id;
      });
      return { ok: true, id, ref };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      )
        continue;
      throw err;
    }
  }
  throw new Error("cartera_ref_conflict");
}

export type SaveHomeResult =
  | {
      ok: true;
      id: string;
      status: string;
      errors: Array<{ path: string; message: string }>;
      slugLocked: boolean;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      error:
        "not_found" | "invalid_status" | "published_to_draft" | "too_large";
    };

export async function saveHome(
  db: Prisma.TransactionClient,
  site: SiteForHomes,
  homeId: string,
  input: HomeSaveInput,
  actor: string,
  now: Date = new Date(),
): Promise<SaveHomeResult> {
  const home = await findOwnedHome(db, site.id, homeId);
  if (!home) return { ok: false, error: "not_found" };
  const before = {
    ref: home.ref,
    operation: home.operation as CarteraOperation,
    status: home.status,
    data: (home.data &&
    typeof home.data === "object" &&
    !Array.isArray(home.data)
      ? home.data
      : {}) as Record<string, unknown>,
    errors: home.errors,
    slugLocked: home.slugLocked,
    firstPublishedAt: home.firstPublishedAt,
  };
  const r = computeHomeSave(before, input, { agents: siteAgents(site) }, now);
  if (!r.ok) return r;

  await db.carteraHome.update({
    where: { id: home.id },
    data: {
      status: r.status,
      data: r.data as Prisma.InputJsonValue,
      errors: r.errors.length
        ? (r.errors as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      price: r.price,
      title: r.title,
      slugLocked: r.slugLocked,
      firstPublishedAt: r.firstPublishedAt,
      updatedBy: actor,
    },
  });

  const audit = (action: string, metadata: Prisma.InputJsonValue) =>
    auditCartera(db, {
      siteId: site.id,
      clientId: site.clientId,
      entity: "home",
      entityId: home.id,
      action,
      actor,
      metadata,
    });
  if (r.changes.price)
    await audit("price_changed", {
      ref: home.ref,
      from: r.changes.price.from,
      to: r.changes.price.to,
    });
  if (r.changes.status)
    await audit("status_changed", {
      ref: home.ref,
      from: r.changes.status.from,
      to: r.changes.status.to,
    });
  const otherFields = r.changes.fields.filter(
    (f) => !["price", "rent", "priceHistory"].includes(f),
  );
  if (otherFields.length > 0)
    await audit("updated", { ref: home.ref, fields: otherFields });
  if (!home.firstPublishedAt && r.firstPublishedAt)
    await audit("first_published", { ref: home.ref });
  if (r.affectsWeb) await markPending(db, site.id, now);

  return {
    ok: true,
    id: home.id,
    status: r.status,
    errors: r.errors,
    slugLocked: r.slugLocked,
    data: r.data,
  };
}

export type DeleteHomeResult =
  | { ok: true; storageKeys: string[] }
  | { ok: false; error: "not_found" | "not_a_draft" };

/** Solo un borrador nunca publicado. Devuelve los ficheros de sus fotos: se
 *  borran del volumen DESPUÉS de confirmar la transacción (deleteHomeFiles). */
export async function deleteHome(
  db: Prisma.TransactionClient,
  site: SiteForHomes,
  homeId: string,
  actor: string,
): Promise<DeleteHomeResult> {
  const home = await findOwnedHome(db, site.id, homeId);
  if (!home) return { ok: false, error: "not_found" };
  if (!canDeleteHome(home)) return { ok: false, error: "not_a_draft" };
  const photos = await db.carteraPhoto.findMany({
    where: { homeId: home.id },
    select: { storageKey: true },
  });
  await db.carteraHome.delete({ where: { id: home.id } });
  await auditCartera(db, {
    siteId: site.id,
    clientId: site.clientId,
    entity: "home",
    entityId: home.id,
    action: "deleted",
    actor,
    metadata: { ref: home.ref, photos: photos.length },
  });
  return { ok: true, storageKeys: photos.map((p) => p.storageKey) };
}

export async function deleteHomeFiles(
  storageKeys: readonly string[],
): Promise<void> {
  await removePhotoFiles(storageKeys);
}

// --- Lo que lee el panel ----------------------------------------------------

/** Una fila de la tabla «Casas». `errors` va entero: el panel enseña el primero. */
export async function listHomesForPanel(db: Db, siteId: string) {
  const rows = await db.carteraHome.findMany({
    where: { siteId },
    orderBy: [{ updatedAt: 'desc' }],
    select: { id: true, ref: true, operation: true, status: true, price: true, title: true, errors: true, updatedAt: true, firstPublishedAt: true, _count: { select: { photos: true } } },
  });
  return rows.map((h) => ({
    id: h.id,
    ref: h.ref,
    operation: h.operation,
    status: h.status,
    price: h.price,
    title: h.title,
    errors: Array.isArray(h.errors) ? (h.errors as Array<{ path: string; message: string }>) : [],
    updatedAt: h.updatedAt.toISOString(),
    published: h.firstPublishedAt !== null,
    photoCount: h._count.photos,
  }));
}

/** Una casa entera para la ficha, con sus fotos en orden. */
export async function loadHomeForPanel(db: Db, siteId: string, homeId: string) {
  const home = await db.carteraHome.findFirst({
    where: { id: homeId, siteId },
    include: { photos: { orderBy: { position: 'asc' }, select: { id: true, width: true, height: true, bytes: true, position: true, alt: true } } },
  });
  if (!home) return null;
  return {
    id: home.id,
    ref: home.ref,
    operation: home.operation as CarteraOperation,
    status: home.status,
    data: (home.data && typeof home.data === 'object' && !Array.isArray(home.data) ? home.data : {}) as Record<string, unknown>,
    errors: Array.isArray(home.errors) ? (home.errors as Array<{ path: string; message: string }>) : [],
    slugLocked: home.slugLocked,
    published: home.firstPublishedAt !== null,
    updatedAt: home.updatedAt.toISOString(),
    photos: home.photos.map((p) => ({ id: p.id, width: p.width, height: p.height, bytes: p.bytes, alt: (p.alt ?? {}) as { es?: string; en?: string; de?: string } })),
  };
}
export type PanelHome = NonNullable<Awaited<ReturnType<typeof loadHomeForPanel>>>;
export type PanelHomeRow = Awaited<ReturnType<typeof listHomesForPanel>>[number];
