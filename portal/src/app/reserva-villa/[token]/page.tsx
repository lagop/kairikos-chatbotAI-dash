import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { confirmDepositFromReturn, loadRequestByGuestToken } from '@/lib/villas/requests';
import { fromDbDate } from '@/lib/villas/dates';
import { formatCents, type StayQuote } from '@/lib/villas/pricing';
import { formatDay, formatDeadline } from '@/lib/villas/emails';

export const dynamic = 'force-dynamic';

// =============================================================================
// Reserva propia para villas — la página del huésped: /reserva-villa/<token>.
//
// Sin cuenta: el token largo del enlace del correo es la llave (como un
// «ver mi reserva» de cualquier hotel). Enseña el estado de la solicitud, el
// precio total con IVA y su desglose, y —solo si el dueño la aceptó y está en
// plazo— el botón de pagar el depósito, que es un <form> normal hacia Stripe
// Checkout (funciona sin JavaScript). Al volver de Stripe (?pago=ok) se
// comprueba el pago leyendo la sesión guardada, no lo que diga la URL.
//
// En el idioma de la solicitud (es/en). noindex, como todo el portal.
// =============================================================================

export const metadata: Metadata = {
  title: 'Tu solicitud de reserva',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Lang = 'es' | 'en';

const T = {
  es: {
    title: 'Tu solicitud',
    ref: 'Referencia',
    villa: 'Villa',
    arrival: 'Llegada',
    departure: 'Salida',
    nights: 'noches',
    guests: 'Huéspedes',
    adults: (n: number) => `${n} adulto${n === 1 ? '' : 's'}`,
    children: (n: number) => `${n} niño${n === 1 ? '' : 's'}`,
    base: 'Precio base',
    cleaning: 'Limpieza',
    tax: 'Tasa turística',
    total: 'Total, IVA incluido',
    vat: (pct: string, amount: string) => `Incluye ${amount} de IVA (${pct})`,
    deposit: 'Depósito para confirmar',
    balance: 'Resto',
    pay: 'Pagar el depósito',
    payNote: 'Pagas en la página segura de Stripe; los datos de tu tarjeta no pasan por esta web.',
    testMode: 'Modo de prueba: no se cobra dinero real. Usa la tarjeta 4242 4242 4242 4242.',
    back: 'Volver a la web',
    status: {
      pending: (deadline: string) =>
        `Solicitud enviada. El anfitrión la revisa y contesta antes del ${deadline}. Hasta entonces no se cobra nada.`,
      accepted: (deposit: string, deadline: string) =>
        `¡Aceptada! Para confirmar la reserva, paga el depósito de ${deposit} antes del ${deadline}. Si no se paga a tiempo, las fechas quedan libres.`,
      confirmed: 'Reserva confirmada. Hemos recibido tu depósito.',
      declined: 'Lo sentimos: la villa no está disponible en esas fechas. No se ha cobrado nada.',
      expired: 'Esta solicitud ha caducado sin cobrarse nada. Puedes enviar otra cuando quieras.',
      cancelled: 'Esta reserva se ha cancelado. Si pagaste un depósito, el anfitrión se pondrá en contacto contigo.',
    },
    payment: {
      cancelado: 'No se ha completado el pago. Puedes intentarlo otra vez.',
      'fuera-de-plazo': 'El plazo para pagar el depósito ha terminado.',
      error: 'No hemos podido abrir la página de pago. Inténtalo de nuevo en unos minutos.',
      espera: 'Demasiados intentos seguidos. Espera un minuto.',
      ok: 'Estamos comprobando el pago. Si acabas de pagar, recarga la página en unos segundos.',
    } as Record<string, string>,
  },
  en: {
    title: 'Your request',
    ref: 'Reference',
    villa: 'Villa',
    arrival: 'Arrival',
    departure: 'Departure',
    nights: 'nights',
    guests: 'Guests',
    adults: (n: number) => `${n} adult${n === 1 ? '' : 's'}`,
    children: (n: number) => `${n} child${n === 1 ? '' : 'ren'}`,
    base: 'Base rate',
    cleaning: 'Cleaning',
    tax: 'Tourist tax',
    total: 'Total, VAT included',
    vat: (pct: string, amount: string) => `Includes ${amount} VAT (${pct})`,
    deposit: 'Deposit to confirm',
    balance: 'Balance',
    pay: 'Pay the deposit',
    payNote: 'You pay on Stripe’s secure page; your card details never reach this website.',
    testMode: 'Test mode: no real money is charged. Use card 4242 4242 4242 4242.',
    back: 'Back to the website',
    status: {
      pending: (deadline: string) => `Request sent. The host will review it and reply before ${deadline}. Nothing is charged until then.`,
      accepted: (deposit: string, deadline: string) =>
        `Accepted! To confirm the booking, pay the deposit of ${deposit} before ${deadline}. If it is not paid in time, the dates are released.`,
      confirmed: 'Booking confirmed. We have received your deposit.',
      declined: 'We are sorry: the villa is not available on those dates. Nothing has been charged.',
      expired: 'This request has expired and nothing has been charged. You can send a new one whenever you like.',
      cancelled: 'This booking has been cancelled. If you paid a deposit, the host will contact you.',
    },
    payment: {
      cancelado: 'The payment was not completed. You can try again.',
      'fuera-de-plazo': 'The deadline to pay the deposit has passed.',
      error: 'We could not open the payment page. Please try again in a few minutes.',
      espera: 'Too many attempts in a row. Please wait a minute.',
      ok: 'We are checking the payment. If you have just paid, reload the page in a few seconds.',
    } as Record<string, string>,
  },
};

export default async function GuestRequestPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await props.params;
  const search = await props.searchParams;
  if (!isDatabaseConfigured) notFound();
  const pago = typeof search.pago === 'string' ? search.pago : null;
  if (pago === 'ok') await confirmDepositFromReturn(prisma, { guestToken: token });

  const request = await loadRequestByGuestToken(prisma, token);
  if (!request) notFound();
  const lang: Lang = request.lang === 'en' ? 'en' : 'es';
  const t = T[lang];
  const locale = lang === 'en' ? 'en-GB' : 'es-ES';
  const money = (cents: number) => formatCents(cents, request.currency, locale);
  const quote = request.quote as unknown as StayQuote;
  const rental = request.rental;
  const tz = rental.timeZone;
  const now = new Date();
  const payable = request.status === 'accepted' && request.paymentDueAt !== null && request.paymentDueAt > now;

  const statusText =
    request.status === 'pending'
      ? t.status.pending(formatDeadline(request.expiresAt, lang, tz))
      : request.status === 'accepted'
        ? payable
          ? t.status.accepted(money(request.depositCents), formatDeadline(request.paymentDueAt!, lang, tz))
          : t.status.expired
        : (t.status[request.status as keyof typeof t.status] as string | undefined) ?? '';
  const paymentNotice = pago && !(pago === 'ok' && request.status === 'confirmed') ? t.payment[pago] : null;
  const tone =
    request.status === 'confirmed'
      ? 'border-kairikos-success/40 bg-kairikos-success/10'
      : request.status === 'accepted' || request.status === 'pending'
        ? 'border-kairikos-accent2/40 bg-kairikos-accent2/10'
        : 'border-kairikos-border bg-kairikos-surface2';

  const vatPct = `${(quote.vatRateBps ?? 0) / 100} %`;

  return (
    <main lang={lang} className="mx-auto max-w-xl px-4 py-10 text-kairikos-text">
      <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">{rental.businessName}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {t.title} · {request.villa.name}
      </h1>

      <p role="status" className={`mt-5 rounded-lg border p-4 text-sm ${tone}`}>
        {statusText}
      </p>
      {paymentNotice ? <p className="mt-3 text-sm text-kairikos-warning">{paymentNotice}</p> : null}

      <dl className="mt-6 grid grid-cols-[auto,1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-kairikos-muted">{t.ref}</dt>
        <dd className="font-mono">{request.reference}</dd>
        <dt className="text-kairikos-muted">{t.arrival}</dt>
        <dd>{formatDay(fromDbDate(request.checkIn), lang)}</dd>
        <dt className="text-kairikos-muted">{t.departure}</dt>
        <dd>
          {formatDay(fromDbDate(request.checkOut), lang)} · {quote.nights} {t.nights}
        </dd>
        <dt className="text-kairikos-muted">{t.guests}</dt>
        <dd>
          {t.adults(request.adults)}
          {request.children ? `, ${t.children(request.children)}` : ''}
        </dd>
      </dl>

      <table className="mt-6 w-full text-sm">
        <tbody>
          {quote.lines.map((line, i) => (
            <tr key={i} className="border-t border-kairikos-border">
              <td className="py-2">
                {line.season ?? t.base} · {line.nights} × {money(line.nightlyCents)}
              </td>
              <td className="py-2 text-right tabular-nums">{money(line.subtotalCents)}</td>
            </tr>
          ))}
          {quote.cleaningFeeCents > 0 ? (
            <tr className="border-t border-kairikos-border">
              <td className="py-2">{t.cleaning}</td>
              <td className="py-2 text-right tabular-nums">{money(quote.cleaningFeeCents)}</td>
            </tr>
          ) : null}
          {quote.touristTaxCents > 0 ? (
            <tr className="border-t border-kairikos-border">
              <td className="py-2">{t.tax}</td>
              <td className="py-2 text-right tabular-nums">{money(quote.touristTaxCents)}</td>
            </tr>
          ) : null}
          <tr className="border-t-2 border-kairikos-text/60 font-semibold">
            <td className="py-2">{t.total}</td>
            <td className="py-2 text-right tabular-nums">{money(request.totalCents)}</td>
          </tr>
          <tr>
            <td colSpan={2} className="pb-2 text-xs text-kairikos-muted">
              {t.vat(vatPct, money(quote.vatCents ?? 0))}
            </td>
          </tr>
          <tr className="border-t border-kairikos-border">
            <td className="py-2">
              {t.deposit} ({quote.depositPercent} %)
            </td>
            <td className="py-2 text-right tabular-nums">{money(request.depositCents)}</td>
          </tr>
          <tr className="border-t border-kairikos-border">
            <td className="py-2">{t.balance}</td>
            <td className="py-2 text-right tabular-nums">{money(request.totalCents - request.depositCents)}</td>
          </tr>
        </tbody>
      </table>

      {rental.balanceNote ? <p className="mt-4 text-sm text-kairikos-muted">{rental.balanceNote}</p> : null}
      {rental.cancellationNote ? <p className="mt-2 text-sm text-kairikos-muted">{rental.cancellationNote}</p> : null}

      {payable ? (
        <form method="post" action={`/api/public/villas/solicitud/${token}/checkout`} className="mt-6">
          <button
            type="submit"
            className="w-full rounded-lg bg-kairikos-accent px-4 py-3 font-semibold text-white hover:bg-kairikos-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kairikos-accent"
          >
            {t.pay} · {money(request.depositCents)}
          </button>
          <p className="mt-2 text-xs text-kairikos-muted">{t.payNote}</p>
          {rental.stripeKeyMode === 'test' ? <p className="mt-1 text-xs text-kairikos-warning">{t.testMode}</p> : null}
        </form>
      ) : null}

      {rental.siteUrl ? (
        <p className="mt-8 text-sm">
          <a className="text-kairikos-accent underline" href={rental.siteUrl}>
            {t.back}
          </a>
        </p>
      ) : null}
    </main>
  );
}
