import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { loadBusyRanges, rentalToday } from '@/lib/villas/rental';
import { addDays } from '@/lib/villas/dates';
import { buildIcs } from '@/lib/villas/ical';
import { allowRead } from '@/lib/villas/public-http';
import { frozenCalendarDescription, serviceState } from '@/lib/villas/exit-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/villas/ical/<icalToken>.ics — el calendario de SALIDA de una
 * villa, el que el dueño pega en Airbnb y Booking («Importar calendario»).
 *
 * Lleva las solicitudes aceptadas (dentro de su plazo de pago) y confirmadas,
 * los bloqueos manuales y los importados de los otros calendarios: así Airbnb
 * se entera de lo de Booking y al revés. Cada evento dice solo «Reservado» o
 * «No disponible»: ni nombres ni correos ni referencias, porque esta URL la
 * guardan terceros.
 *
 * Limitación conocida (docs/plan-reserva-villas.md): un bloqueo de Booking
 * vuelve a salir hacia Airbnb, y al cancelarse tarda dos refrescos en
 * desaparecer de todas partes.
 *
 * Contratación no activa (pausada, o dada de baja dentro del plazo de gracia):
 * se sigue sirviendo el último estado, con X-WR-CALDESC diciendo que ya no se
 * actualiza. Un 404 o un calendario vacío pueden hacer que Airbnb o Booking
 * suelten fechas de reservas directas que el dueño ya confirmó y que siguen
 * valiendo: eso es una reserva doble. Bloquear de más es el error seguro, y
 * el dueño lo arregla quitando la URL, que es lo que el aviso de baja le pide.
 * Fuera de plazo (o villa desactivada), 404; poco después, la purga.
 *
 * El token es un secreto ligero (solo da a saber qué días están ocupados).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ file: string }> }) {
  const { file } = await props.params;
  const token = file.replace(/\.ics$/i, '');
  if (!/^ical_[A-Za-z0-9_-]{10,60}$/.test(token)) return new NextResponse('Not found', { status: 404 });
  if (!allowRead(token)) return new NextResponse('Too many requests', { status: 429 });
  if (!isDatabaseConfigured) return new NextResponse('Service unavailable', { status: 503 });

  const villa = await prisma.villa.findFirst({
    where: { icalToken: token, isActive: true },
    select: {
      id: true,
      name: true,
      rental: {
        select: {
          timeZone: true,
          businessName: true,
          exitNotifiedAt: true,
          clientProduct: { select: { status: true, cancelledAt: true, changedAt: true } },
        },
      },
    },
  });
  if (!villa) return new NextResponse('Not found', { status: 404 });
  const now = new Date();
  const exit = serviceState(villa.rental.clientProduct, villa.rental.exitNotifiedAt, now);
  if (exit.state === 'closed') return new NextResponse('Not found', { status: 404 });

  // Desde ayer: las plataformas no necesitan el pasado, y un día de margen
  // cubre la diferencia de zona horaria con quien lo lea.
  const today = rentalToday(villa.rental, now);
  const busy = await loadBusyRanges(prisma, villa.id, { today: addDays(today, -1), now });
  const description =
    exit.state === 'active'
      ? undefined
      : frozenCalendarDescription(villa.rental.clientProduct.cancelledAt ?? villa.rental.clientProduct.changedAt, exit.state);
  const ics = buildIcs(
    `${villa.name} · ${villa.rental.businessName}`,
    busy.map((b) => ({
      uid: `${b.kind}-${b.id}@villas.kairikos`,
      start: b.start,
      end: b.end,
      summary: b.kind === 'request' ? 'Reservado' : 'No disponible',
    })),
    now,
    description,
  );
  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${token}.ics"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
