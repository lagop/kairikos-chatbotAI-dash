// =============================================================================
// Cartera — una base de datos falsa en memoria con lo justo de Prisma para las
// funciones de lib/cartera/* (casas, fotos, sitio, publicaciones, auditoría).
// Entiende los filtros que esas funciones usan: igualdad, null, { not },
// { in }, { startsWith }, { lte } y el estado de la contratación del sitio.
// Respeta el índice único (site, ref) de las casas.
//
// Lo que NO prueba: el SQL. Eso se comprueba aparte contra Postgres (ver la
// descripción de cada PR).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

type Row = Record<string, unknown> & { id: string };

const clone = <T>(v: T): T => structuredClone(v);
const dbNull = (v: unknown) => (v === Prisma.DbNull ? null : v);
const cleanData = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, dbNull(v)]));

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Array<Record<string, unknown>>).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if (key === 'clientProduct' || key === 'home' || key === 'product') return matches((value ?? {}) as Record<string, unknown>, c);
      if ('not' in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('startsWith' in c) return typeof value === 'string' && value.startsWith(String(c.startsWith));
      if ('lte' in c) return value instanceof Date && value.getTime() <= (c.lte as Date).getTime();
      if ('lt' in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
      if ('gte' in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
      return true;
    }
    return value === cond;
  });
}

function sortBy<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const out = [...rows];
  for (const spec of [...list].reverse()) {
    const [key, dir] = Object.entries(spec as Record<string, string>)[0];
    out.sort((a, b) => {
      const av = a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number | string);
      const bv = b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number | string);
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    });
  }
  return out;
}

export interface FakeSiteInput {
  id?: string;
  clientId?: string;
  githubRepo?: string | null;
  contractStatus?: string;
  agents?: unknown;
  lastPublishedCount?: number | null;
  feedToken?: string;
  buildSecretHash?: string | null;
}

export function fakeCarteraDb(opts: { failNextHomeCreate?: boolean } = {}) {
  const homes: Row[] = [];
  const photos: Row[] = [];
  const builds: Row[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const sites: Row[] = [];
  const clients: Row[] = [];
  const enquiries: Row[] = [];
  const leads: Row[] = [];
  const leadAudits: Array<Record<string, unknown>> = [];
  let failNext = opts.failNextHomeCreate ?? false;

  const withPhotos = (h: Row) => {
    const own = photos.filter((p) => p.homeId === h.id);
    return { ...clone(h), photos: sortBy(own, { position: 'asc' }).map(clone), _count: { photos: own.length } };
  };
  const siteView = (s: Row) => ({ ...clone(s), clientProduct: clone(s.clientProduct) });

  const db = {
    carteraHome: {
      findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => sortBy(homes.filter((h) => matches(h, where)), orderBy).map(withPhotos),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const h = homes.find((x) => matches(x, where));
        return h ? withPhotos(h) : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const h = homes.find((x) => x.id === where.id);
        return h ? withPhotos(h) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (failNext || homes.some((h) => h.siteId === data.siteId && h.ref === data.ref)) {
          failNext = false;
          // La otra alta se quedó la referencia mientras esta calculaba la suya.
          homes.push({ id: randomUUID(), siteId: data.siteId, ref: data.ref, status: 'borrador', operation: data.operation, data: {}, errors: null, firstPublishedAt: null, slugLocked: false, updatedAt: new Date() });
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' });
        }
        const row: Row = { id: randomUUID(), price: null, title: null, slugLocked: false, firstPublishedAt: null, createdAt: new Date(), updatedAt: new Date(), ...clone(cleanData(data)) };
        homes.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const h = homes.find((x) => x.id === where.id)!;
        Object.assign(h, clone(cleanData(data)), { updatedAt: new Date() });
        return clone(h);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        homes.splice(homes.findIndex((h) => h.id === where.id), 1);
        for (let i = photos.length - 1; i >= 0; i--) if (photos[i].homeId === where.id) photos.splice(i, 1);
      },
    },
    carteraPhoto: {
      count: async ({ where }: { where: Record<string, unknown> }) => photos.filter((p) => matches(p, where)).length,
      findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const list = sortBy(photos.filter((p) => matches(p, where)), orderBy);
        return list[0] ? clone(list[0]) : null;
      },
      findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => sortBy(photos.filter((p) => matches(p, where)), orderBy ?? { position: 'asc' }).map(clone),
      create: async ({ data }: { data: Row }) => {
        photos.push(clone(data));
        return clone(data);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(photos.find((p) => p.id === where.id)!, clone(data)),
      delete: async ({ where }: { where: { id: string } }) => photos.splice(photos.findIndex((p) => p.id === where.id), 1),
    },
    carteraSite: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const s = sites.find((x) => x.id === where.id);
        return s ? siteView(s) : null;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const s = sites.find((x) => matches(x, where));
        return s ? siteView(s) : null;
      },
      findMany: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => sortBy(sites.filter((s) => matches(s, where)), orderBy).map(siteView),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(sites.find((s) => s.id === where.id)!, clone(data)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const list = sites.filter((s) => matches(s, where));
        for (const s of list) Object.assign(s, clone(data));
        return { count: list.length };
      },
    },
    carteraBuild: {
      findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const list = sortBy(builds.filter((b) => matches(b, where)), orderBy);
        return list[0] ? clone(list[0]) : null;
      },
      findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) =>
        sortBy(builds.filter((b) => matches(b, where)), orderBy)
          .slice(0, take ?? Infinity)
          .map((b) => ({ ...clone(b), site: { clientId: sites.find((s) => s.id === b.siteId)?.clientId } })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: randomUUID(), finishedAt: null, runUrl: null, error: null, stage: null, release: null, commitSha: null, lastNoticeAt: null, dispatchedAt: new Date(), status: 'enviada', ...clone(data) };
        builds.push(row);
        return clone(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(builds.find((b) => b.id === where.id)!, clone(data)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const list = builds.filter((b) => matches(b, where));
        for (const b of list) Object.assign(b, clone(data));
        return { count: list.length };
      },
    },
    carteraEnquiry: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: randomUUID(), status: 'nuevo', leadId: null, name: null, refs: [], payload: {}, createdAt: new Date(), updatedAt: new Date(), ...clone(data) };
        enquiries.push(row);
        return { id: row.id };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => enquiries.filter((e) => matches(e, where)).length,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => clone(enquiries.find((e) => matches(e, where)) ?? null),
      findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) =>
        sortBy(enquiries.filter((e) => matches(e, where)), orderBy)
          .slice(0, take ?? Infinity)
          .map(clone),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(enquiries.find((e) => e.id === where.id)!, clone(data), { updatedAt: new Date() }),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const gone = enquiries.filter((e) => matches(e, where));
        for (const e of gone) enquiries.splice(enquiries.indexOf(e), 1);
        return { count: gone.length };
      },
    },
    lead: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: randomUUID(), ...clone(data) };
        leads.push(row);
        return { id: row.id };
      },
    },
    leadAudit: { create: async ({ data }: { data: Record<string, unknown> }) => void leadAudits.push(clone(data)) },
    carteraAudit: { create: async ({ data }: { data: Record<string, unknown> }) => void audits.push(clone(data)) },
    chatbotClient: { findUnique: async ({ where }: { where: { id: string } }) => clone(clients.find((c) => c.id === where.id) ?? null) },
    // El bloqueo del sitio (SELECT … FOR UPDATE): aquí todo es secuencial.
    $queryRaw: async () => [],
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };

  function addSite(input: FakeSiteInput = {}) {
    const site: Row = {
      id: input.id ?? randomUUID(),
      clientId: input.clientId ?? 'client-1',
      salePrefix: 'C',
      rentPrefix: 'A',
      agents: input.agents ?? [
        { key: 'lucia', name: 'Lucía' },
        { key: 'elena', name: 'Elena' },
      ],
      githubRepo: input.githubRepo === undefined ? 'lagop/web-prueba' : input.githubRepo,
      workflowFile: 'publicar.yml',
      siteUrl: 'https://agencia.example',
      tenantId: null,
      enquiriesPurgedAt: null,
      pendingSince: null,
      lastChangeAt: null,
      lastDispatchAt: null,
      lastPublishedCount: input.lastPublishedCount ?? null,
      feedToken: input.feedToken ?? `car_${randomUUID().replace(/-/g, '')}`,
      buildSecretHash: input.buildSecretHash ?? null,
      clientProduct: { status: input.contractStatus ?? 'active', product: { code: 'cartera' } },
    };
    sites.push(site);
    clients.push({ id: String(site.clientId), email: 'agencia@example.com', name: 'Lucía Ortega', companyName: 'Alféizar Inmobiliaria' });
    return site as Row & { clientId: string; salePrefix: string; rentPrefix: string; agents: Prisma.JsonValue };
  }

  return { db, homes, photos, builds, audits, sites, enquiries, leads, leadAudits, addSite };
}

export type FakeCarteraDb = ReturnType<typeof fakeCarteraDb>;
