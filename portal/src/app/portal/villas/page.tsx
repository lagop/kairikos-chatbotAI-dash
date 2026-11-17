import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { VillasExitView, VillasPanel, type VillasPanelData } from '@/components/portal/VillasPanel';
import { findRentalForOwner, rentalToday } from '@/lib/villas/rental';
import { fromDbDate, toDbDate } from '@/lib/villas/dates';
import { hasStripeKey, isLiveModeAllowed } from '@/lib/villas/stripe-deposit';
import { isBlocking } from '@/lib/villas/request-rules';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { VILLAS_TAB_PARAM, parseVillasTab } from '@/lib/villas/panel-tabs';
import { calendarHistoryStart } from '@/lib/villas/panel-calendar';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Reservas de villas',
  robots: { index: false, follow: false },
};

// =============================================================================
// Reserva propia para villas — el panel del dueño (/portal/villas).
//
// Lo primero son las solicitudes que esperan respuesta, con su plazo: es lo
// único urgente. Debajo, cada villa (precios, temporadas, calendarios), las
// condiciones y Stripe, y el código para pegar el widget en la web.
//
// En el menú sale solo a quien tiene la contratación (portalNavFor, en
// portal-nav.ts; lo decide el layout) y el resumen (/portal) le pone una
// tarjeta. Al resto no: el producto lo tienen pocos y el menú base es común.
// Antes no salía en ningún sitio y solo se llegaba por el correo de cada
// solicitud.
// =============================================================================

export default async function VillasPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // ?seccion= elige la pestaña con la que abre el panel (panel-tabs.ts).
  const initialTab = parseVillasTab((await props.searchParams)[VILLAS_TAB_PARAM]);
  await requirePortalSession();
  const resolved = isDatabaseConfigured ? await resolveClientFromSession() : null;
  const owner = resolved?.source === 'database' ? await findRentalForOwner(prisma, resolved.clientId) : null;

  // Dada de baja dentro del plazo, o suspendida sin estar en pausa (impago,
  // pendiente de pago): solo lectura y exportación. Pausada sigue siendo el
  // panel de siempre (las rutas de escritura la aceptan).
  if (owner && owner.state !== 'active' && owner.rental.clientProduct.status !== 'paused') {
    const exitNow = new Date();
    const [exitVillas, upcomingConfirmed] = await Promise.all([
      prisma.villa.findMany({
        where: { rentalId: owner.rental.id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, icalToken: true },
      }),
      prisma.villaBookingRequest.count({
        where: { rentalId: owner.rental.id, status: 'confirmed', checkOut: { gt: toDbDate(rentalToday(owner.rental, exitNow)) } },
      }),
    ]);
    const exitBase = portalBaseUrl();
    return (
      <div>
        <PageHeading eyebrow="Reservas" title="Reserva propia para villas" />
        <VillasExitView
          mode={owner.state === 'grace' ? 'grace' : 'suspended'}
          graceEndsAt={owner.graceEndsAt?.toISOString() ?? null}
          timeZone={owner.rental.timeZone}
          villas={exitVillas.map((v) => ({ id: v.id, name: v.name, icalExportUrl: `${exitBase}/api/public/villas/ical/${v.icalToken}.ics` }))}
          upcomingConfirmed={upcomingConfirmed}
        />
      </div>
    );
  }
  const rental = owner?.rental ?? null;

  if (!rental) {
    return (
      <div>
        <PageHeading eyebrow="Reservas" title="Reserva propia para villas" />
        <EmptyState
          title="No está activa en tu cuenta"
          description="La reserva propia para villas (calendario, sincronización con Airbnb y Booking, solicitudes y depósito con Stripe) se contrata con tu web Signature."
          action={
            <Link href="/portal/support" className="btn-primary">
              Hablar con soporte
            </Link>
          }
        />
      </div>
    );
  }

  const now = new Date();
  const today = rentalToday(rental, now);
  // El calendario de ocupación enseña también los últimos meses: cierres
  // manuales, bloqueos importados y estancias confirmadas desde aquí.
  const historyFrom = toDbDate(calendarHistoryStart(today));
  const [villas, requests, pastStays] = await Promise.all([
    prisma.villa.findMany({
      where: { rentalId: rental.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        seasons: { orderBy: { startDate: 'asc' } },
        feeds: { orderBy: { createdAt: 'asc' } },
        blocks: { where: { feedId: null, endDate: { gt: historyFrom } }, orderBy: { startDate: 'asc' } },
      },
    }),
    prisma.villaBookingRequest.findMany({
      where: {
        rentalId: rental.id,
        OR: [{ status: { in: ['pending', 'accepted'] } }, { checkOut: { gt: toDbDate(today) } }, { updatedAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } }],
      },
      orderBy: [{ checkIn: 'asc' }],
      take: 200,
    }),
    prisma.villaBookingRequest.findMany({
      where: { rentalId: rental.id, status: 'confirmed', checkOut: { gt: historyFrom, lte: toDbDate(today) } },
      orderBy: [{ checkIn: 'asc' }],
      take: 500,
      select: { id: true, villaId: true, status: true, reference: true, guestName: true, checkIn: true, checkOut: true, totalCents: true },
    }),
  ]);

  const base = portalBaseUrl();
  const blockingByVilla = new Map<string, Array<{ id: string; start: string; end: string }>>();
  for (const r of requests) {
    if (!isBlocking(r, now)) continue;
    const list = blockingByVilla.get(r.villaId) ?? [];
    list.push({ id: r.id, start: fromDbDate(r.checkIn), end: fromDbDate(r.checkOut) });
    blockingByVilla.set(r.villaId, list);
  }
  const importedBlocks = await prisma.villaBlock.findMany({
    where: { villaId: { in: villas.map((v) => v.id) }, feedId: { not: null }, endDate: { gt: historyFrom } },
    select: { villaId: true, startDate: true, endDate: true, feed: { select: { label: true } } },
  });

  const data: VillasPanelData = {
    today,
    timeZone: rental.timeZone,
    settings: {
      businessName: rental.businessName,
      ownerEmail: rental.ownerEmail,
      ownerPhone: rental.ownerPhone,
      siteUrl: rental.siteUrl,
      timeZone: rental.timeZone,
      depositPercent: rental.depositPercent,
      confirmHours: rental.confirmHours,
      paymentHours: rental.paymentHours,
      balanceNote: rental.balanceNote,
      cancellationNote: rental.cancellationNote,
    },
    stripe: {
      configured: hasStripeKey(rental),
      mode: rental.stripeKeyMode,
      hint: rental.stripeKeyHint,
      liveAllowed: isLiveModeAllowed(),
    },
    embed: {
      publicToken: rental.publicToken,
      scriptUrl: `${base}/widget/villas.v1.js`,
    },
    villas: villas.map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      maxGuests: v.maxGuests,
      nightlyCents: v.nightlyCents,
      minNights: v.minNights,
      cleaningFeeCents: v.cleaningFeeCents,
      vatRateBps: v.vatRateBps,
      touristTaxCents: v.touristTaxCents,
      isActive: v.isActive,
      instantBooking: v.instantBooking,
      icalExportUrl: `${base}/api/public/villas/ical/${v.icalToken}.ics`,
      seasons: v.seasons.map((s) => ({
        name: s.name,
        startDate: fromDbDate(s.startDate),
        endDate: fromDbDate(s.endDate),
        nightlyCents: s.nightlyCents,
        minNights: s.minNights,
      })),
      feeds: v.feeds.map((f) => ({
        id: f.id,
        label: f.label,
        host: (() => {
          try {
            return new URL(f.url).hostname;
          } catch {
            return f.url;
          }
        })(),
        lastSyncedAt: f.lastSyncedAt?.toISOString() ?? null,
        lastStatus: f.lastStatus,
        lastError: f.lastError,
        errorSince: f.errorSince?.toISOString() ?? null,
        eventCount: f.eventCount,
      })),
      manualBlocks: v.blocks.map((b) => ({ id: b.id, start: fromDbDate(b.startDate), end: fromDbDate(b.endDate), note: b.note })),
      // Ya se leían para avisar de solapes en las pendientes; ahora también
      // van al panel, que los pinta en el calendario de ocupación.
      importedBlocks: importedBlocks
        .filter((b) => b.villaId === v.id)
        .map((b) => ({ start: fromDbDate(b.startDate), end: fromDbDate(b.endDate), label: b.feed?.label ?? 'iCal' })),
    })),
    pastStays: pastStays.map((r) => ({
      id: r.id,
      villaId: r.villaId,
      status: r.status,
      reference: r.reference,
      guestName: r.guestName,
      checkIn: fromDbDate(r.checkIn),
      checkOut: fromDbDate(r.checkOut),
      totalCents: r.totalCents,
    })),
    requests: requests.map((r) => {
      const checkIn = fromDbDate(r.checkIn);
      const checkOut = fromDbDate(r.checkOut);
      // Aviso, no bloqueo: una pendiente que ya choca con algo ocupado. Aceptarla
      // fallará igualmente; así el dueño lo ve antes de pulsar.
      const clash =
        r.status === 'pending'
          ? [
              ...(blockingByVilla.get(r.villaId) ?? []).filter((b) => b.id !== r.id && b.start < checkOut && checkIn < b.end).map(() => 'otra reserva'),
              ...importedBlocks
                .filter((b) => b.villaId === r.villaId && fromDbDate(b.startDate) < checkOut && checkIn < fromDbDate(b.endDate))
                .map((b) => b.feed?.label ?? 'iCal'),
            ]
          : [];
      return {
        id: r.id,
        reference: r.reference,
        villaId: r.villaId,
        status: r.status,
        checkIn,
        checkOut,
        adults: r.adults,
        children: r.children,
        guestName: r.guestName,
        guestEmail: r.guestEmail,
        guestPhone: r.guestPhone,
        message: r.message,
        totalCents: r.totalCents,
        depositCents: r.depositCents,
        expiresAt: r.expiresAt.toISOString(),
        paymentDueAt: r.paymentDueAt?.toISOString() ?? null,
        paidAt: r.paidAt?.toISOString() ?? null,
        declineReason: r.declineReason,
        createdAt: r.createdAt.toISOString(),
        source: r.source,
        clashesWith: Array.from(new Set(clash)),
      };
    }),
  };

  return (
    <div>
      <PageHeading
        eyebrow="Reservas"
        title="Reserva propia para villas"
        description="Las solicitudes llegan desde tu web. Tú decides: al aceptar, el huésped recibe el enlace para pagar el depósito con Stripe. Nada se cobra antes."
      />
      <VillasPanel data={data} initialTab={initialTab} />
    </div>
  );
}
