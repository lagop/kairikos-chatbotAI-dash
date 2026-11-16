import 'server-only';
import { NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { buildCsv } from '@/lib/lead-export';
import { buildIcs } from './ical';
import { auditVilla } from './rental';
import {
  AUDIT_COLUMNS,
  EXPORT_KINDS,
  REQUEST_COLUMNS,
  VILLA_COLUMNS,
  auditRecord,
  exportEvents,
  exportFileName,
  requestRecord,
  villaRecords,
  type ExportKind,
} from './export-format';

// =============================================================================
// Reserva propia para villas — exportación de los datos del dueño.
//
// La usan el panel (/api/portal/villas/export, también dado de baja dentro del
// plazo de gracia) y el operador (/api/admin/portal/villas/export, hasta la
// purga). Cada descarga deja una fila de auditoría: son datos personales de
// huéspedes saliendo del portal, y si alguien pregunta quién se los llevó y
// cuándo, la respuesta tiene que estar.
// =============================================================================

export function parseExportKind(value: string | null): ExportKind | null {
  return value && (EXPORT_KINDS as readonly string[]).includes(value) ? (value as ExportKind) : null;
}

export type ExportResult =
  | { ok: true; filename: string; contentType: string; body: string; rows: number }
  | { ok: false; error: 'villa_required' | 'villa_not_found' };

export async function buildVillaExport(
  db: PrismaClient,
  rental: { id: string; clientId: string; businessName: string },
  kind: ExportKind,
  opts: { villaId?: string | null; actor: string; now?: Date },
): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  let result: Extract<ExportResult, { ok: true }>;

  if (kind === 'solicitudes') {
    const rows = await db.villaBookingRequest.findMany({
      where: { rentalId: rental.id },
      include: { villa: { select: { name: true } } },
      orderBy: [{ checkIn: 'asc' }, { createdAt: 'asc' }],
    });
    result = csv(kind, rental, now, buildCsv(rows.map(requestRecord), REQUEST_COLUMNS), rows.length);
  } else if (kind === 'villas') {
    const villas = await db.villa.findMany({
      where: { rentalId: rental.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { seasons: { orderBy: { startDate: 'asc' } }, feeds: { select: { label: true, url: true }, orderBy: { createdAt: 'asc' } } },
    });
    result = csv(kind, rental, now, buildCsv(villas.flatMap(villaRecords), VILLA_COLUMNS), villas.length);
  } else if (kind === 'auditoria') {
    const rows = await db.villaRentalAudit.findMany({ where: { rentalId: rental.id }, orderBy: { createdAt: 'asc' } });
    result = csv(kind, rental, now, buildCsv(rows.map(auditRecord), AUDIT_COLUMNS), rows.length);
  } else {
    if (!opts.villaId) return { ok: false, error: 'villa_required' };
    if (!/^[0-9a-f-]{36}$/i.test(opts.villaId)) return { ok: false, error: 'villa_not_found' };
    const villa = await db.villa.findFirst({ where: { id: opts.villaId, rentalId: rental.id }, select: { id: true, name: true, slug: true } });
    if (!villa) return { ok: false, error: 'villa_not_found' };
    const [requests, blocks] = await Promise.all([
      db.villaBookingRequest.findMany({
        where: { villaId: villa.id, status: 'confirmed' },
        select: { id: true, reference: true, guestName: true, checkIn: true, checkOut: true },
      }),
      db.villaBlock.findMany({
        where: { villaId: villa.id },
        select: { id: true, startDate: true, endDate: true, note: true, feed: { select: { label: true } } },
      }),
    ]);
    const events = exportEvents(requests, blocks);
    result = {
      ok: true,
      filename: exportFileName('ics', rental.businessName, now, villa.slug),
      contentType: 'text/calendar; charset=utf-8',
      body: buildIcs(`${villa.name} · ${rental.businessName} (exportación)`, events, now),
      rows: events.length,
    };
  }

  await auditVilla(db, {
    rentalId: rental.id,
    clientId: rental.clientId,
    entity: 'rental',
    entityId: rental.id,
    action: 'exported',
    actor: opts.actor,
    metadata: { kind, rows: result.rows, ...(opts.villaId ? { villaId: opts.villaId } : {}) },
  });
  return result;
}

function csv(kind: ExportKind, rental: { businessName: string }, now: Date, body: string, rows: number): Extract<ExportResult, { ok: true }> {
  // El BOM: sin él, Excel en Windows abre «Castaño» como «CastaÃ±o» (igual
  // que en la exportación de leads).
  return { ok: true, filename: exportFileName(kind, rental.businessName, now), contentType: 'text/csv; charset=utf-8', body: `﻿${body}`, rows };
}

export function exportResponse(result: ExportResult): NextResponse {
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === 'villa_required' ? 400 : 404 });
  return new NextResponse(result.body, {
    status: 200,
    headers: {
      'content-type': result.contentType,
      'content-disposition': `attachment; filename="${result.filename}"`,
      'cache-control': 'no-store',
    },
  });
}
