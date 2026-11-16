// =============================================================================
// Reserva propia para villas — qué columnas lleva cada exportación del dueño
// (baja del cliente, docs/plan-reserva-villas.md). Puro: filas → registros
// para buildCsv (lib/lead-export.ts) y eventos para buildIcs.
//
// Es la devolución de datos del RGPD (art. 28.3.g), así que va TODO lo que
// tenemos del huésped y de la reserva, en un formato que se pueda importar en
// otra herramienta: fechas ISO, importes en euros con punto decimal y los
// códigos de estado tal cual, con su traducción al lado.
// =============================================================================

import type { ExportEvent } from './ical';

const STATUS_ES: Record<string, string> = {
  pending: 'pendiente',
  accepted: 'aceptada, esperando depósito',
  confirmed: 'confirmada',
  declined: 'rechazada',
  expired: 'caducada',
  cancelled: 'cancelada',
};

export const REQUEST_COLUMNS = [
  { header: 'referencia', key: 'reference' },
  { header: 'villa', key: 'villa' },
  { header: 'estado', key: 'status' },
  { header: 'estado_texto', key: 'statusText' },
  { header: 'motivo_rechazo', key: 'declineReason' },
  { header: 'entrada', key: 'checkIn' },
  { header: 'salida', key: 'checkOut' },
  { header: 'noches', key: 'nights' },
  { header: 'adultos', key: 'adults' },
  { header: 'ninos', key: 'children' },
  { header: 'nombre', key: 'guestName' },
  { header: 'email', key: 'guestEmail' },
  { header: 'telefono', key: 'guestPhone' },
  { header: 'idioma', key: 'lang' },
  { header: 'mensaje_huesped', key: 'message' },
  { header: 'total_eur_iva_incluido', key: 'total' },
  { header: 'iva_eur', key: 'vat' },
  { header: 'deposito_eur', key: 'deposit' },
  { header: 'resto_eur', key: 'balance' },
  { header: 'moneda', key: 'currency' },
  { header: 'solicitada', key: 'createdAt' },
  { header: 'consentimiento', key: 'consentAt' },
  { header: 'decidida', key: 'decidedAt' },
  { header: 'plazo_pago', key: 'paymentDueAt' },
  { header: 'pagada', key: 'paidAt' },
  { header: 'stripe_payment_intent', key: 'stripePaymentIntentId' },
  { header: 'origen', key: 'source' },
] as const;

export const VILLA_COLUMNS = [
  { header: 'villa', key: 'villa' },
  { header: 'slug', key: 'slug' },
  { header: 'tipo', key: 'kind' },
  { header: 'nombre', key: 'name' },
  { header: 'desde', key: 'start' },
  { header: 'hasta_incluida', key: 'end' },
  { header: 'precio_noche_eur_iva_incluido', key: 'nightly' },
  { header: 'estancia_minima', key: 'minNights' },
  { header: 'huespedes_max', key: 'maxGuests' },
  { header: 'limpieza_eur', key: 'cleaning' },
  { header: 'iva_pct', key: 'vatPct' },
  { header: 'tasa_turistica_eur_adulto_noche', key: 'touristTax' },
  { header: 'activa', key: 'active' },
  { header: 'url', key: 'url' },
] as const;

export const AUDIT_COLUMNS = [
  { header: 'fecha', key: 'createdAt' },
  { header: 'entidad', key: 'entity' },
  { header: 'id', key: 'entityId' },
  { header: 'accion', key: 'action' },
  { header: 'quien', key: 'actor' },
  { header: 'detalles', key: 'metadata' },
] as const;

/** 60000 → "600.00". Punto decimal: lo entiende cualquier importador. */
export function euros(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const isoTime = (d: Date | null | undefined) => (d ? d.toISOString() : '');

export interface RequestExportRow {
  reference: string;
  status: string;
  declineReason: string | null;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  lang: string;
  message: string | null;
  totalCents: number;
  depositCents: number;
  currency: string;
  quote: unknown;
  createdAt: Date;
  consentAt: Date | null;
  decidedAt: Date | null;
  paymentDueAt: Date | null;
  paidAt: Date | null;
  stripePaymentIntentId: string | null;
  source: string | null;
  villa: { name: string };
}

export function requestRecord(r: RequestExportRow): Record<string, unknown> {
  const quote = (r.quote ?? {}) as { vatCents?: unknown; nights?: unknown };
  const nights = Math.round((r.checkOut.getTime() - r.checkIn.getTime()) / 86_400_000);
  return {
    reference: r.reference,
    villa: r.villa.name,
    status: r.status,
    statusText: STATUS_ES[r.status] ?? r.status,
    declineReason: r.declineReason,
    checkIn: isoDay(r.checkIn),
    checkOut: isoDay(r.checkOut),
    nights,
    adults: r.adults,
    children: r.children,
    guestName: r.guestName,
    guestEmail: r.guestEmail,
    guestPhone: r.guestPhone,
    lang: r.lang,
    message: r.message,
    total: euros(r.totalCents),
    vat: typeof quote.vatCents === 'number' ? euros(quote.vatCents) : '',
    deposit: euros(r.depositCents),
    balance: euros(r.totalCents - r.depositCents),
    currency: r.currency,
    createdAt: isoTime(r.createdAt),
    consentAt: isoTime(r.consentAt),
    decidedAt: isoTime(r.decidedAt),
    paymentDueAt: isoTime(r.paymentDueAt),
    paidAt: isoTime(r.paidAt),
    stripePaymentIntentId: r.stripePaymentIntentId,
    source: r.source,
  };
}

export interface VillaExportRow {
  name: string;
  slug: string;
  maxGuests: number;
  nightlyCents: number;
  minNights: number;
  cleaningFeeCents: number;
  vatRateBps: number;
  touristTaxCents: number;
  isActive: boolean;
  seasons: Array<{ name: string; startDate: Date; endDate: Date; nightlyCents: number; minNights: number }>;
  feeds: Array<{ label: string; url: string }>;
}

/** Una fila «base» por villa, una por temporada y una por calendario
 *  importado (la URL de Airbnb o Booking es del dueño y la necesita para
 *  conectar su próxima herramienta). */
export function villaRecords(v: VillaExportRow): Array<Record<string, unknown>> {
  const common = { villa: v.name, slug: v.slug };
  return [
    {
      ...common,
      kind: 'base',
      name: '',
      nightly: euros(v.nightlyCents),
      minNights: v.minNights,
      maxGuests: v.maxGuests,
      cleaning: euros(v.cleaningFeeCents),
      vatPct: (v.vatRateBps / 100).toString(),
      touristTax: euros(v.touristTaxCents),
      active: v.isActive ? 'si' : 'no',
    },
    ...v.seasons.map((s) => ({
      ...common,
      kind: 'temporada',
      name: s.name,
      start: isoDay(s.startDate),
      end: isoDay(s.endDate),
      nightly: euros(s.nightlyCents),
      minNights: s.minNights,
    })),
    ...v.feeds.map((f) => ({ ...common, kind: 'calendario_importado', name: f.label, url: f.url })),
  ];
}

export function auditRecord(a: { createdAt: Date; entity: string; entityId: string; action: string; actor: string; metadata: unknown }): Record<string, unknown> {
  return {
    createdAt: isoTime(a.createdAt),
    entity: a.entity,
    entityId: a.entityId,
    action: a.action,
    actor: a.actor,
    metadata: a.metadata && typeof a.metadata === 'object' && Object.keys(a.metadata).length > 0 ? JSON.stringify(a.metadata) : '',
  };
}

/**
 * El .ics de la exportación. A diferencia del público (que ve Airbnb), este es
 * para el dueño: lleva referencia y nombre del huésped, y la nota de cada
 * bloqueo. Las solicitudes, solo confirmadas: las demás no ocupan nada.
 */
export function exportEvents(
  requests: ReadonlyArray<{ id: string; reference: string; guestName: string; checkIn: Date; checkOut: Date }>,
  blocks: ReadonlyArray<{ id: string; startDate: Date; endDate: Date; note: string | null; feed: { label: string } | null }>,
): ExportEvent[] {
  return [
    ...requests.map((r) => ({
      uid: `request-${r.id}@villas.kairikos`,
      start: isoDay(r.checkIn),
      end: isoDay(r.checkOut),
      summary: `Reserva ${r.reference} · ${r.guestName}`,
    })),
    ...blocks.map((b) => ({
      uid: `${b.feed ? 'ical' : 'manual'}-${b.id}@villas.kairikos`,
      start: isoDay(b.startDate),
      end: isoDay(b.endDate),
      summary: b.feed ? `No disponible (${b.feed.label})` : `No disponible${b.note ? ` · ${b.note}` : ''}`,
    })),
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export type ExportKind = 'solicitudes' | 'villas' | 'auditoria' | 'ics';
export const EXPORT_KINDS: readonly ExportKind[] = ['solicitudes', 'villas', 'auditoria', 'ics'];

export function exportFileName(kind: ExportKind, rentalName: string, now: Date, villaSlug?: string): string {
  const base = rentalName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'villas';
  const day = isoDay(now);
  return kind === 'ics' ? `${base}-${villaSlug ?? 'villa'}-${day}.ics` : `${base}-${kind}-${day}.csv`;
}
