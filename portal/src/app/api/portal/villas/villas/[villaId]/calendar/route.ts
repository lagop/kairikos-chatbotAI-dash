import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { findOwnedVilla, requireVillaPortal } from '@/lib/villas/portal-auth';
import { auditVilla, rentalToday } from '@/lib/villas/rental';
import { isIsoDate, nightsBetween, toDbDate } from '@/lib/villas/dates';
import { feedHost, normalizeFeedUrl, syncFeed, syncVillaFeeds } from '@/lib/villas/ical-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/villas/villas/[villaId]/calendar
 *   { action: 'add_feed', label, url }      importar el iCal de Airbnb/Booking (se lee al momento)
 *   { action: 'remove_feed', feedId }       deja de importarlo (y borra sus bloqueos)
 *   { action: 'sync' }                      leer ya todos los de la villa
 *   { action: 'add_block', start, end, note? }   noches cerradas a mano [start, end)
 *   { action: 'remove_block', blockId }     solo bloqueos manuales
 *
 * Una sola ruta con acciones porque las cinco son «el calendario de esta
 * villa» y comparten la comprobación de propiedad. La URL de un iCal nunca va
 * entera a la auditoría (lleva el token de la plataforma): solo su host.
 */
const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_feed'), label: z.string().trim().min(1).max(40), url: z.string().trim().min(10).max(1000) }),
  z.object({ action: z.literal('remove_feed'), feedId: z.string().uuid() }),
  z.object({ action: z.literal('sync') }),
  z.object({
    action: z.literal('add_block'),
    start: z.string().refine(isIsoDate),
    end: z.string().refine(isIsoDate),
    note: z.string().trim().max(120).optional(),
  }),
  z.object({ action: z.literal('remove_block'), blockId: z.string().uuid() }),
]);

const MAX_FEEDS_PER_VILLA = 6;

export async function POST(req: NextRequest, props: { params: Promise<{ villaId: string }> }) {
  const { villaId } = await props.params;
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const villa = await findOwnedVilla(ctx.rental.id, villaId);
  if (!villa) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const today = rentalToday(ctx.rental);
  const audit = (entity: 'feed' | 'block', entityId: string, action: string, metadata: Record<string, unknown> = {}) =>
    auditVilla(prisma, { rentalId: ctx.rental.id, clientId: ctx.clientId, entity, entityId, action, actor: ctx.actor, metadata: { villaId: villa.id, ...metadata } });

  switch (body.data.action) {
    case 'add_feed': {
      const url = normalizeFeedUrl(body.data.url);
      if (!url) return NextResponse.json({ error: 'invalid_url', message: 'Tiene que ser la URL https de exportación del calendario.' }, { status: 400 });
      const count = await prisma.villaCalendarFeed.count({ where: { villaId: villa.id } });
      if (count >= MAX_FEEDS_PER_VILLA) return NextResponse.json({ error: 'too_many_feeds' }, { status: 409 });
      const feed = await prisma.villaCalendarFeed.create({ data: { villaId: villa.id, label: body.data.label, url } });
      await audit('feed', feed.id, 'created', { host: feedHost(url), label: body.data.label });
      const sync = await syncFeed(prisma, feed, { today });
      return NextResponse.json({ ok: true, feedId: feed.id, sync }, { status: 201 });
    }
    case 'remove_feed': {
      const feed = await prisma.villaCalendarFeed.findFirst({ where: { id: body.data.feedId, villaId: villa.id } });
      if (!feed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      await prisma.villaCalendarFeed.delete({ where: { id: feed.id } }); // sus bloqueos caen en cascada
      await audit('feed', feed.id, 'removed', { host: feedHost(feed.url), label: feed.label });
      return NextResponse.json({ ok: true });
    }
    case 'sync': {
      const result = await syncVillaFeeds(prisma, villa.id, { today });
      return NextResponse.json({ ok: true, ...result });
    }
    case 'add_block': {
      // Cerrar el pasado no sirve de nada y ensucia el histórico del calendario.
      if (body.data.start < today) return NextResponse.json({ error: 'past_dates' }, { status: 400 });
      const nights = nightsBetween(body.data.start, body.data.end);
      if (nights < 1 || nights > 366) return NextResponse.json({ error: 'invalid_range' }, { status: 400 });
      const block = await prisma.villaBlock.create({
        data: { villaId: villa.id, startDate: toDbDate(body.data.start), endDate: toDbDate(body.data.end), note: body.data.note || null },
      });
      await audit('block', block.id, 'created', { start: body.data.start, end: body.data.end });
      return NextResponse.json({ ok: true, blockId: block.id }, { status: 201 });
    }
    case 'remove_block': {
      // Solo los manuales: los importados los manda su calendario.
      const block = await prisma.villaBlock.findFirst({ where: { id: body.data.blockId, villaId: villa.id, feedId: null } });
      if (!block) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      await prisma.villaBlock.delete({ where: { id: block.id } });
      await audit('block', block.id, 'removed');
      return NextResponse.json({ ok: true });
    }
  }
}
