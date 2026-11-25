import 'server-only';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { auditCartera, type Db } from './site';
import { buildFeed, type AlquilerFeedItem, type VentaFeedItem } from './feed';
import { alquilerFeedSchema, ventaFeedSchema } from './schema';
import { carteraFotosDir, resolvePhotoPath } from './photos';
import { KIND_LABELS, type EnquiryKind } from './enquiry-rules';
import { zipStream, type ZipEntry } from './zip';
import { toWebStream } from '../web-stream';

// =============================================================================
// Cartera — la exportación (PR 6): un ZIP con la estructura del repositorio de
// la web, para descomprimirlo en su raíz y seguir construyendo sin el portal.
// Contrato: docs/exportacion.md de la plantilla.
//
//   LEEME.txt
//   src/content/inmuebles/c-101.json     cada casa como en el feed, salvo las fotos
//   src/content/alquileres/a-201.json
//   src/content/fotos/c-101/<id>.jpg     fotos y fotos 360°, con el id del portal
//   borradores/c-115.json                lo que no se publica, con sus `errors`
//   borradores/fotos/c-115/<id>.jpg      (sus fotos: ver abajo)
//   contactos.csv                        datos personales: no van al repositorio
//
// El nombre de cada foto es su id del portal, el mismo último segmento de su
// dirección en el feed (/api/public/cartera/foto/<id>), y no un número de
// orden. La web casa por ese nombre lo que escribe Kairikos en su archivo de
// escala: `cotas` (a qué parte del plano mira cada foto) y `panoRooms` (a qué
// estancia va cada foto 360°). Hasta el 25/11/2026 las fotos salían como
// 01.jpg, 02.jpg…: la web exportada construía, pero las cotas dejaban de casar
// en silencio. El orden lo da el JSON (la primera es la portada), no el nombre.
//
// En dos pasos. `planCarteraExport` lo prepara todo y lo comprueba ANTES de
// mandar un solo byte: cada JSON de src/content/ valida con el esquema (el
// mismo que el de la web) y cada foto está en el volumen. Si algo falla, no hay
// ZIP: es un fallo del portal, no de la agencia, y una exportación que no
// construye es peor que ninguna. Después la ruta lo manda en streaming
// (zip.ts): las fotos se leen del volumen al vuelo, nunca todas en memoria.
//
// Las fotos de los borradores no están en el contrato, que solo nombra
// `borradores/<ref>.json`. Van en `borradores/fotos/<ref>/`, fuera de src/
// como su JSON, y su `url` ya apunta a `fotos/<ref>/…`: al pasar un borrador a
// src/content/ se mueven las dos cosas y construye. Son datos de la agencia y
// se los tiene que llevar (también en la baja).
// =============================================================================

const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Lo común a una foto y a una foto 360°: un fichero del volumen con su orden. */
interface ExportFileRow {
  id: string;
  width: number;
  height: number;
  position: number;
  storageKey: string;
  mime: string;
  bytes: number;
}

interface ExportPhotoRow extends ExportFileRow {
  alt: Prisma.JsonValue;
}

export type ExportPlan = {
  filename: string;
  entries: ZipEntry[];
  counts: { homes: number; drafts: number; photos: number; panos: number; enquiries: number };
};

export type PlanResult = { ok: true; plan: ExportPlan } | { ok: false; error: 'invalid_home' | 'missing_photo' | 'storage_not_configured'; detail: string };

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** «2026-11-20» en hora de Madrid, para el nombre del archivo y el LEEME. */
export function madridDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function madridDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    d,
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function exportFileName(agency: string, now: Date): string {
  const slug =
    agency
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agencia';
  return `cartera-${slug}-${madridDay(now)}.zip`;
}

// --- CSV de contactos ------------------------------------------------------------------

export const CONTACT_COLUMNS = ['fecha', 'tipo', 'referencias', 'nombre', 'contacto', 'idioma', 'consentimiento', 'estado', 'detalle'] as const;

/** Un valor para el CSV con `;`. Lo que empieza por = + - @ se neutraliza con
 *  un apóstrofo, como en la exportación de leads: Excel lo ejecutaría. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface ContactRow {
  createdAt: Date;
  kind: string;
  refs: string[];
  name: string | null;
  contact: string;
  lang: string;
  consentAt: Date;
  status: string;
  payload: Prisma.JsonValue;
}

/** UTF-8 con BOM y `;`, CRLF: se abre bien en Excel en español. */
export function buildContactsCsv(rows: readonly ContactRow[]): string {
  const lines = [CONTACT_COLUMNS.join(';')];
  for (const r of rows) {
    lines.push(
      [madridDateTime(r.createdAt), KIND_LABELS[r.kind as EnquiryKind] ?? r.kind, r.refs.join(' '), r.name, r.contact, r.lang, madridDateTime(r.consentAt), r.status, JSON.stringify(r.payload ?? {})]
        .map(csvCell)
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// --- LEEME ---------------------------------------------------------------------------------

export function buildReadme(agency: string, now: Date, counts: ExportPlan['counts']): string {
  return [
    `Cartera de ${agency} — exportación del ${madridDay(now)}`,
    '',
    `${counts.homes} casas publicables, ${counts.drafts} sin publicar, ${counts.photos} fotos, ${counts.panos} fotos 360° y ${counts.enquiries} contactos.`,
    '',
    'QUÉ HAY EN ESTE ZIP',
    '',
    '- src/content/inmuebles/: una casa en venta por archivo (c-101.json…), en el formato de tu web.',
    '- src/content/alquileres/: una casa en alquiler por archivo.',
    '- src/content/fotos/<referencia>/: las fotos y las fotos 360° de cada casa. Cada archivo se llama como en el portal; el orden (la primera es la portada) lo da el JSON de la casa. No les cambies el nombre: el plano a escala de tu web los nombra así.',
    '- borradores/: las casas que no se publican (borradores o con avisos), con los avisos en "errors" y sus fotos en borradores/fotos/. Están fuera de src/ para que no rompan la web.',
    '- contactos.csv: los contactos que llegaron desde los formularios de tu web. Tiene datos personales: lee el final.',
    '',
    'CÓMO USARLO EN TU WEB',
    '',
    '1. En el repositorio de tu web, borra src/content/inmuebles/, src/content/alquileres/ y src/content/fotos/.',
    '2. Descomprime este ZIP en la raíz del repositorio.',
    '3. Quita contactos.csv (no debe quedarse en el repositorio) y la carpeta borradores/ si no la quieres ahí.',
    '4. Construye sin PORTFOLIO_FEED_URL y con PORTFOLIO_REQUIRED vacío: la web sale de estos archivos, sin el portal.',
    '',
    'Los planos a escala (src/content/escala/) ya están en tu repositorio y no vienen aquí. Un plano sin su casa solo da un aviso al construir.',
    '',
    'Para publicar un borrador: corrige lo que dice "errors" y quita esa clave, mueve el JSON a src/content/inmuebles/ (o a alquileres/) y sus fotos de borradores/fotos/<referencia>/ a src/content/fotos/<referencia>/.',
    '',
    'DATOS PERSONALES',
    '',
    'contactos.csv tiene nombres, teléfonos y emails de personas que escribieron desde tu web, con la fecha en que aceptaron la política de privacidad. Tu agencia es la responsable de esos datos: no lo subas al repositorio ni lo compartas, y guárdalo solo el tiempo que diga tu política de privacidad.',
    '',
  ].join('\r\n');
}

// --- El plan ---------------------------------------------------------------------------------

function sortedPhotos<R extends ExportFileRow>(photos: readonly R[]): R[] {
  return [...photos].sort((a, b) => a.position - b.position);
}

/** Las fotos (o las fotos 360°) de una casa, en orden: su sitio en el ZIP y su
 *  `url` en el JSON. El archivo se llama con el id de la fila (ver la cabecera). */
function localPhotos<R extends ExportFileRow>(ref: string, photos: readonly R[], prefix: string) {
  const lower = ref.toLowerCase();
  return sortedPhotos(photos).map((p) => {
    // Un tipo que no sea JPEG, PNG o WebP no debería existir (la subida solo
    // admite esos tres). Si aparece, conserva su extensión en vez de hacerse
    // pasar por .jpg: la web no la acepta (LOCAL_PHOTO) y la validación previa
    // para la exportación antes de mandar un ZIP que no construye.
    const ext = MIME_EXT[p.mime] ?? ((p.mime.split('/')[1] ?? '').replace(/[^a-z0-9]/g, '') || 'bin');
    const file = `${p.id.toLowerCase()}.${ext}`;
    return { row: p, url: `fotos/${lower}/${file}`, zipName: `${prefix}fotos/${lower}/${file}` };
  });
}

function toAlt(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string>;
}

export async function planCarteraExport(db: Db, site: { id: string; clientId: string }, now: Date = new Date()): Promise<PlanResult> {
  const [client, homes, enquiries] = await Promise.all([
    db.chatbotClient.findUnique({ where: { id: site.clientId }, select: { name: true, companyName: true } }),
    db.carteraHome.findMany({
      where: { siteId: site.id },
      orderBy: { ref: 'asc' },
      select: {
        ref: true,
        operation: true,
        status: true,
        data: true,
        errors: true,
        photos: { select: { id: true, width: true, height: true, position: true, alt: true, storageKey: true, mime: true, bytes: true }, orderBy: { position: 'asc' } },
        panos: { select: { id: true, width: true, height: true, position: true, storageKey: true, mime: true, bytes: true }, orderBy: { position: 'asc' } },
      },
    }),
    db.carteraEnquiry.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, kind: true, refs: true, name: true, contact: true, lang: true, consentAt: true, status: true, payload: true },
    }),
  ]);
  const agency = client?.companyName?.trim() || client?.name?.trim() || 'agencia';

  // Las casas de src/content/ son las del feed, tal cual van en él.
  const { feed, skipped } = buildFeed(homes, { baseUrl: 'https://portal.invalid', now });
  const byRef = new Map(homes.map((h) => [h.ref, h]));
  const inFeed = new Set([...feed.ventas, ...feed.alquileres].map((h) => h.ref));

  const dir = carteraFotosDir();
  const photoCount = homes.reduce((n, h) => n + h.photos.length, 0);
  const panoCount = homes.reduce((n, h) => n + h.panos.length, 0);
  if (photoCount + panoCount > 0 && !dir) return { ok: false, error: 'storage_not_configured', detail: 'CARTERA_FOTOS_DIR' };

  const contentEntries: ZipEntry[] = [];
  const photoEntries: ZipEntry[] = [];
  const draftEntries: ZipEntry[] = [];

  async function addPhotos(list: ReadonlyArray<{ row: ExportFileRow; zipName: string }>, into: ZipEntry[]): Promise<string | null> {
    for (const p of list) {
      const full = resolvePhotoPath(dir!, p.row.storageKey);
      const size = full
        ? await stat(full)
            .then((s) => (s.isFile() ? s.size : null))
            .catch(() => null)
        : null;
      if (!full || size === null) return p.row.id;
      into.push({ name: p.zipName, file: full, size });
    }
    return null;
  }

  const published: Array<[string, VentaFeedItem | AlquilerFeedItem]> = [
    ...feed.ventas.map((v) => ['inmuebles', v] as [string, VentaFeedItem]),
    ...feed.alquileres.map((a) => ['alquileres', a] as [string, AlquilerFeedItem]),
  ];
  for (const [folder, item] of published) {
    const row = byRef.get(item.ref)!;
    const local = localPhotos(item.ref, row.photos, 'src/content/');
    const localPanos = localPhotos(item.ref, row.panos, 'src/content/');
    // Mismo orden que el feed (feedPhotos y feedPanos ordenan por posición):
    // solo cambia la url. Sin fotos 360°, sin el campo, como en el feed.
    const doc = {
      ...item,
      photos: item.photos.map((ph, i) => ({ ...ph, url: local[i].url })),
      ...(item.panos ? { panos: item.panos.map((pa, i) => ({ ...pa, url: localPanos[i].url })) } : {}),
    };
    const schema = folder === 'inmuebles' ? ventaFeedSchema : alquilerFeedSchema;
    const checked = schema.safeParse(doc);
    if (!checked.success) {
      const first = checked.error.issues[0];
      return { ok: false, error: 'invalid_home', detail: `${item.ref}: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim() };
    }
    contentEntries.push({ name: `src/content/${folder}/${item.ref.toLowerCase()}.json`, data: json(doc) });
    const missing = (await addPhotos(local, photoEntries)) ?? (await addPhotos(localPanos, photoEntries));
    if (missing) return { ok: false, error: 'missing_photo', detail: `${item.ref}: ${missing}` };
  }

  // Lo que no está en el feed: borradores, casas con avisos y las que el esquema rechazó.
  const skippedRefs = new Set(skipped.map((s) => s.ref));
  let drafts = 0;
  for (const row of homes) {
    if (inFeed.has(row.ref)) continue;
    const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : {};
    const local = localPhotos(row.ref, row.photos, 'borradores/');
    const localPanos = localPhotos(row.ref, row.panos, 'borradores/');
    const errors = Array.isArray(row.errors) ? [...row.errors] : [];
    if (skippedRefs.has(row.ref) && errors.length === 0) errors.push({ path: '', message: 'No valida con el formato de la web.' });
    const doc = {
      ...data,
      ref: row.ref,
      status: row.status,
      photos: local.map((p) => ({ url: p.url, width: p.row.width, height: p.row.height, alt: toAlt(p.row.alt) })),
      ...(localPanos.length ? { panos: localPanos.map((p) => ({ url: p.url, width: p.row.width, height: p.row.height })) } : {}),
      errors,
    };
    draftEntries.push({ name: `borradores/${row.ref.toLowerCase()}.json`, data: json(doc) });
    const missing = (await addPhotos(local, draftEntries)) ?? (await addPhotos(localPanos, draftEntries));
    if (missing) return { ok: false, error: 'missing_photo', detail: `${row.ref}: ${missing}` };
    drafts++;
  }

  const counts = { homes: inFeed.size, drafts, photos: photoCount, panos: panoCount, enquiries: enquiries.length };
  const entries: ZipEntry[] = [
    { name: 'LEEME.txt', data: Buffer.from(buildReadme(agency, now, counts), 'utf8') },
    ...contentEntries,
    ...photoEntries,
    ...draftEntries,
    { name: 'contactos.csv', data: Buffer.from(buildContactsCsv(enquiries), 'utf8') },
  ];
  return { ok: true, plan: { filename: exportFileName(agency, now), entries, counts } };
}

/** Cada descarga, en la auditoría: cuántas cosas, nunca cuáles personas. */
export async function auditExport(db: Db, site: { id: string; clientId: string }, plan: ExportPlan, actor: string): Promise<void> {
  await auditCartera(db, { siteId: site.id, clientId: site.clientId, entity: 'export', entityId: site.id, action: 'exported', actor, metadata: { ...plan.counts } });
}

/** La descarga: el ZIP en streaming, sin caché. Un fallo a medias (una foto
 *  que desaparece mientras se copia) corta la descarga y queda en el log. */
export function exportResponse(plan: ExportPlan, onError: (err: unknown) => void): NextResponse {
  return new NextResponse(toWebStream(zipStream(plan.entries, new Date()), onError), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${plan.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
