'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { EXIT_GRACE_DAYS } from '@/lib/villas/exit-rules';
import { DEFAULT_VILLAS_TAB, VILLAS_TABS, neighbourVillasTab, villasTabHref, type VillasTabId } from '@/lib/villas/panel-tabs';

// =============================================================================
// Reserva propia para villas — el panel del dueño (cliente). Los datos llegan
// ya preparados de /portal/villas/page.tsx; cada acción llama a su ruta de
// /api/portal/villas/* y refresca la página. Ninguna regla de negocio vive
// aquí: aceptar, rechazar o cobrar lo decide lib/villas/requests.ts.
//
// Va en cuatro pestañas (lib/villas/panel-tabs.ts). Los cuatro paneles están
// SIEMPRE montados y el que no toca lleva `hidden`: si se desmontaran, cambiar
// de pestaña borraría un formulario a medio rellenar (una temporada, la clave
// de Stripe). La pestaña vive en el estado y se copia a la URL con
// history.replaceState, sin navegar: así no se vuelve a pedir toda la página
// al servidor por cambiar de pestaña, y aun así un enlace o un F5 la conservan.
// =============================================================================

export interface VillasPanelData {
  today: string;
  timeZone: string;
  settings: {
    businessName: string;
    ownerEmail: string | null;
    ownerPhone: string | null;
    siteUrl: string | null;
    timeZone: string;
    depositPercent: number;
    confirmHours: number;
    paymentHours: number;
    balanceNote: string | null;
    cancellationNote: string | null;
  };
  stripe: { configured: boolean; mode: string | null; hint: string | null; liveAllowed: boolean };
  embed: { publicToken: string; scriptUrl: string };
  villas: Array<{
    id: string;
    slug: string;
    name: string;
    maxGuests: number;
    nightlyCents: number;
    minNights: number;
    cleaningFeeCents: number;
    vatRateBps: number;
    touristTaxCents: number;
    isActive: boolean;
    icalExportUrl: string;
    seasons: Array<{ name: string; startDate: string; endDate: string; nightlyCents: number; minNights: number }>;
    feeds: Array<{ id: string; label: string; host: string; lastSyncedAt: string | null; lastStatus: string | null; lastError: string | null; eventCount: number }>;
    manualBlocks: Array<{ id: string; start: string; end: string; note: string | null }>;
  }>;
  requests: Array<{
    id: string;
    reference: string;
    villaId: string;
    status: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    guestName: string;
    guestEmail: string;
    guestPhone: string | null;
    message: string | null;
    totalCents: number;
    depositCents: number;
    expiresAt: string;
    paymentDueAt: string | null;
    paidAt: string | null;
    declineReason: string | null;
    createdAt: string;
    source: string | null;
    clashesWith: string[];
  }>;
}

const eur = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const toCents = (value: string) => Math.round(Number(value.replace(',', '.')) * 100);
const fromCents = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, '');

function day(iso: string) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}
function when(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
}
function nights(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const ERROR_TEXT: Record<string, string> = {
  conflict: 'Esas noches ya están ocupadas (otra reserva o un calendario importado). No se ha aceptado.',
  stripe_not_configured: 'Antes de aceptar, guarda tu clave de Stripe (abajo): al aceptar, el huésped recibe el enlace para pagar.',
  expired: 'La solicitud ya ha caducado.',
  invalid_transition: 'Esta solicitud ya cambió de estado. Recarga la página.',
  slug_taken: 'Ya hay una villa con ese identificador.',
  invalid_url: 'Tiene que ser la URL https de exportación del calendario.',
  too_many_feeds: 'Como mucho seis calendarios por villa.',
  invalid_body: 'Revisa los campos marcados.',
};

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

function errorMessage(data: Record<string, unknown>): string {
  if (typeof data.message === 'string') return data.message;
  const code = typeof data.error === 'string' ? data.error : 'error';
  return ERROR_TEXT[code] ?? `No se ha podido guardar (${code}).`;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  async function run(method: string, url: string, body?: unknown, okText = 'Guardado.') {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data } = await call(method, url, body);
      if (!ok || data.ok === false) {
        setMessage({ tone: 'error', text: errorMessage(data) });
        return null;
      }
      setMessage({ tone: 'ok', text: okText });
      router.refresh();
      return data;
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, run, setMessage };
}

function Notice({ message }: { message: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!message) return null;
  return (
    <p role="status" className={`text-sm ${message.tone === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}>
      {message.text}
    </p>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1 max-w-2xl text-sm text-kairikos-muted">{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function TabPanel({ id, active, children }: { id: VillasTabId; active: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`villas-panel-${id}`}
      aria-labelledby={`villas-tab-${id}`}
      hidden={!active}
      data-testid={`villas-panel-${id}`}
      // Section abre con mt-10 para separarse de la sección anterior; pegada a
      // la barra de pestañas ese hueco sobra.
      className="[&>section:first-child]:mt-6"
    >
      {children}
    </div>
  );
}

export function VillasPanel({ data, initialTab = DEFAULT_VILLAS_TAB }: { data: VillasPanelData; initialTab?: VillasTabId }) {
  const [tab, setTab] = useState<VillasTabId>(initialTab);
  const tabRefs = useRef<Partial<Record<VillasTabId, HTMLButtonElement | null>>>({});

  function selectTab(next: VillasTabId, focus = false) {
    setTab(next);
    window.history.replaceState(null, '', villasTabHref(next, window.location.pathname));
    if (focus) tabRefs.current[next]?.focus();
  }

  // Teclado de un tablist: flechas para moverse, Inicio/Fin a los extremos.
  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: VillasTabId | null = null;
    if (event.key === 'ArrowRight') next = neighbourVillasTab(tab, 1);
    else if (event.key === 'ArrowLeft') next = neighbourVillasTab(tab, -1);
    else if (event.key === 'Home') next = VILLAS_TABS[0].id;
    else if (event.key === 'End') next = VILLAS_TABS[VILLAS_TABS.length - 1].id;
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  }

  const villaName = new Map(data.villas.map((v) => [v.id, v.name]));
  const pending = data.requests.filter((r) => r.status === 'pending');
  const accepted = data.requests.filter((r) => r.status === 'accepted');
  const confirmed = data.requests.filter((r) => r.status === 'confirmed' && r.checkOut > data.today);
  const others = data.requests.filter((r) => !pending.includes(r) && !accepted.includes(r) && !confirmed.includes(r)).slice(-15).reverse();

  return (
    <div>
      {!data.stripe.configured ? (
        // Fuera de las pestañas: sin la clave no se puede aceptar nada, y eso
        // hay que verlo se esté en la pestaña que se esté.
        <p className="card flex flex-wrap items-center justify-between gap-3 border-kairikos-warning/50 text-sm" data-testid="villas-stripe-missing">
          <span>Falta tu clave de Stripe: puedes recibir solicitudes, pero no aceptarlas hasta guardarla.</span>
          {tab !== 'cobros' ? (
            <button type="button" className="btn-ghost" onClick={() => selectTab('cobros')}>
              Ir a «Cobros y condiciones»
            </button>
          ) : null}
        </p>
      ) : null}

      <div
        role="tablist"
        aria-label="Secciones de la reserva de villas"
        onKeyDown={onTabKeyDown}
        className="mt-6 flex gap-0.5 overflow-x-auto sm:gap-1 overflow-y-hidden border-b border-kairikos-border"
      >
        {VILLAS_TABS.map((t) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`villas-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`villas-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              data-testid={`villas-tab-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={[
                'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2.5 text-sm transition sm:gap-2 sm:px-3',
                selected
                  ? 'border-kairikos-accent font-semibold text-kairikos-text'
                  : 'border-transparent text-kairikos-muted hover:border-kairikos-border hover:text-kairikos-text',
              ].join(' ')}
            >
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
              {t.id === 'reservas' && pending.length > 0 ? (
                <span className="pill-warning" aria-label={`${pending.length} por responder`}>
                  {pending.length}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <TabPanel id="reservas" active={tab === 'reservas'}>
        <Section title={`Esperan tu respuesta (${pending.length})`} description="Mira tus calendarios de Airbnb y Booking antes de aceptar. Al aceptar, el portal vuelve a leerlos y no te deja si aparece un solape.">
          {pending.length === 0 ? <p className="text-sm text-kairikos-muted">Ninguna ahora mismo.</p> : null}
          {pending.map((r) => (
            <RequestCard key={r.id} r={r} villaName={villaName.get(r.villaId) ?? ''} timeZone={data.timeZone} />
          ))}
        </Section>

        {accepted.length > 0 ? (
          <Section title={`Aceptadas, esperando el depósito (${accepted.length})`}>
            {accepted.map((r) => (
              <RequestCard key={r.id} r={r} villaName={villaName.get(r.villaId) ?? ''} timeZone={data.timeZone} />
            ))}
          </Section>
        ) : null}

        <Section title={`Próximas reservas confirmadas (${confirmed.length})`}>
          {confirmed.length === 0 ? <p className="text-sm text-kairikos-muted">Todavía ninguna.</p> : null}
          {confirmed.map((r) => (
            <RequestCard key={r.id} r={r} villaName={villaName.get(r.villaId) ?? ''} timeZone={data.timeZone} />
          ))}
        </Section>

        {others.length > 0 ? (
          <Section title="Historial reciente">
            <ul className="divide-y divide-kairikos-border text-sm">
              {others.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    <span className="font-mono">{r.reference}</span> · {villaName.get(r.villaId)} · {day(r.checkIn)} → {day(r.checkOut)} · {r.guestName}
                  </span>
                  <StatusBadge status={r.status} reason={r.declineReason} />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

      </TabPanel>

      <TabPanel id="villas" active={tab === 'villas'}>
        <Section title="Tus villas" description="Precios por noche con IVA incluido: es lo que ve el huésped. Las temporadas mandan sobre el precio base; si dos se solapan, gana la más corta.">
          {data.villas.map((v) => (
            <VillaCard key={v.id} villa={v} />
          ))}
          <NewVillaForm />
        </Section>

      </TabPanel>

      <TabPanel id="cobros" active={tab === 'cobros'}>
        <Section title="Condiciones y avisos">
          <SettingsForm settings={data.settings} />
        </Section>

        <Section title="Stripe" description="El depósito se cobra en TU cuenta de Stripe. Crea una clave restringida con «Checkout Sessions: escritura» (Desarrolladores → Claves de API) y pégala aquí. Se guarda cifrada.">
          <StripeForm stripe={data.stripe} />
        </Section>

      </TabPanel>

      <TabPanel id="web" active={tab === 'web'}>
        <Section title="En tu web" description="Pega esto donde quieras el calendario de reserva. Hereda las fuentes y colores de tu web.">
          <pre className="card overflow-x-auto whitespace-pre text-xs">{`<div data-kairikos-villas="${data.embed.publicToken}" data-lang="es"\n     data-fallback-email="${data.settings.ownerEmail ?? 'reservas@tuweb.es'}"></div>\n<script src="${data.embed.scriptUrl}" async></script>`}</pre>
          <p className="max-w-2xl text-sm text-kairikos-muted">
            <code>data-fallback-email</code>, <code>data-fallback-phone</code> o <code>data-fallback-url</code>: lo que enseña el calendario si algún día el servicio
            deja de estar activo (un enlace para escribirte, llamarte o reservar por otro lado). Sin ninguno, no enseña nada.
          </p>
        </Section>

        <Section title="Tus datos" description="Descárgalos cuando quieras. Son tuyos: las solicitudes con los datos de cada huésped, tus villas y precios, el calendario de cada villa y el registro de cambios.">
          <ExportLinks villas={data.villas} />
          <p className="card max-w-2xl text-sm">
            Si algún día das de baja el servicio: tendrás {EXIT_GRACE_DAYS_TEXT} para descargar todo desde aquí y, sobre todo, tendrás que quitar de Airbnb y Booking
            la URL de calendario de Kairikos de cada villa, porque deja de actualizarse. Después se borra.
          </p>
        </Section>
      </TabPanel>
    </div>
  );
}

const EXIT_GRACE_DAYS_TEXT = `${EXIT_GRACE_DAYS} días`;

function ExportLinks({ villas }: { villas: Array<{ id: string; name: string }> }) {
  const link = (query: string) => `/api/portal/villas/export?${query}`;
  return (
    <ul className="flex flex-wrap gap-2 text-sm">
      <li>
        <a className="btn-ghost" href={link('tipo=solicitudes')} download>
          Solicitudes y reservas (CSV)
        </a>
      </li>
      <li>
        <a className="btn-ghost" href={link('tipo=villas')} download>
          Villas, precios y temporadas (CSV)
        </a>
      </li>
      {villas.map((v) => (
        <li key={v.id}>
          <a className="btn-ghost" href={link(`tipo=ics&villa=${v.id}`)} download>
            Calendario de {v.name} (.ics)
          </a>
        </li>
      ))}
      <li>
        <a className="btn-ghost" href={link('tipo=auditoria')} download>
          Registro de cambios (CSV)
        </a>
      </li>
    </ul>
  );
}

/**
 * La página durante la baja (o con la contratación suspendida sin estar en
 * pausa): solo lectura. Lo que importa es que se lleve los datos y quite el
 * iCal de las plataformas antes de `graceEndsAt`.
 */
export function VillasExitView({
  mode,
  graceEndsAt,
  timeZone,
  villas,
  upcomingConfirmed,
}: {
  mode: 'grace' | 'suspended';
  graceEndsAt: string | null;
  timeZone: string;
  villas: Array<{ id: string; name: string; icalExportUrl: string }>;
  upcomingConfirmed: number;
}) {
  return (
    <div>
      <div className="card border-kairikos-warning/50 text-sm">
        {mode === 'grace' && graceEndsAt ? (
          <p>
            El servicio está dado de baja. Ya no entran solicitudes desde tu web. Tus datos siguen aquí hasta el <strong>{when(graceEndsAt, timeZone)}</strong>; después se
            borran.
          </p>
        ) : (
          <p>El servicio no está activo ahora mismo: no entran solicitudes desde tu web. Puedes descargar tus datos; para reactivarlo, habla con soporte.</p>
        )}
        {upcomingConfirmed > 0 ? (
          <p className="mt-2">
            Tienes {upcomingConfirmed} reserva(s) confirmada(s) por venir: siguen valiendo. Los datos de esos huéspedes están en «Solicitudes y reservas».
          </p>
        ) : null}
      </div>

      <Section title="1. Quita el calendario de Kairikos de Airbnb y Booking" description="Ya no se actualiza. Mientras dure el plazo sigue enseñando las fechas que había ocupadas, para que nadie te reserve encima, pero ningún cambio tuyo llegará.">
        <ul className="space-y-2 text-sm">
          {villas.map((v) => (
            <li key={v.id} className="card">
              <strong>{v.name}</strong>
              <code className="mt-1 block break-all text-xs">{v.icalExportUrl}</code>
            </li>
          ))}
        </ul>
        <p className="max-w-2xl text-sm text-kairikos-muted">
          En Airbnb: Calendario → Disponibilidad → Conectar calendarios. En Booking: Tarifas y disponibilidad → Sincronizar calendarios. Busca esta URL y elimínala.
        </p>
      </Section>

      <Section title="2. Descarga tus datos">
        <ExportLinks villas={villas} />
      </Section>

      <Section title="3. Quita el calendario de reservas de tu web">
        <p className="max-w-2xl text-sm text-kairikos-muted">
          Mientras siga pegado, enseña el contacto alternativo que pusiste en <code>data-fallback-email</code>, <code>data-fallback-phone</code> o{' '}
          <code>data-fallback-url</code>, o no enseña nada.
        </p>
      </Section>
    </div>
  );
}

function StatusBadge({ status, reason }: { status: string; reason?: string | null }) {
  const label: Record<string, string> = {
    pending: 'Pendiente',
    accepted: 'Esperando depósito',
    confirmed: 'Confirmada',
    declined: reason === 'dates_taken' ? 'Rechazada (fechas ocupadas)' : 'Rechazada',
    expired: 'Caducada',
    cancelled: 'Cancelada',
  };
  return <span className="rounded-full border border-kairikos-border px-2 py-0.5 text-xs">{label[status] ?? status}</span>;
}

function RequestCard({ r, villaName, timeZone }: { r: VillasPanelData['requests'][number]; villaName: string; timeZone: string }) {
  const { busy, message, run } = useAction();
  const act = (action: string, extra: Record<string, unknown> = {}, ok = 'Hecho.') => run('POST', `/api/portal/villas/requests/${r.id}`, { action, ...extra }, ok);
  return (
    <article className="card space-y-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          {villaName} · {day(r.checkIn)} → {day(r.checkOut)} ({nights(r.checkIn, r.checkOut)} noches)
        </p>
        <StatusBadge status={r.status} reason={r.declineReason} />
      </div>
      <p>
        {r.guestName} · <a className="underline" href={`mailto:${r.guestEmail}`}>{r.guestEmail}</a>
        {r.guestPhone ? ` · ${r.guestPhone}` : ''} · {r.adults} adultos{r.children ? `, ${r.children} niños` : ''}
      </p>
      {r.message ? <p className="text-kairikos-muted">«{r.message}»</p> : null}
      <p>
        Total {eur(r.totalCents)} (IVA incluido) · depósito {eur(r.depositCents)} · <span className="font-mono">{r.reference}</span>
        {r.source ? ` · desde ${r.source}` : ''}
      </p>
      {r.status === 'pending' ? <p className="text-kairikos-muted">Contesta antes del {when(r.expiresAt, timeZone)}.</p> : null}
      {r.status === 'accepted' && r.paymentDueAt ? <p className="text-kairikos-muted">El huésped tiene hasta el {when(r.paymentDueAt, timeZone)} para pagar.</p> : null}
      {r.status === 'confirmed' && r.paidAt ? <p className="text-kairikos-muted">Depósito pagado el {when(r.paidAt, timeZone)}.</p> : null}
      {r.clashesWith.length > 0 ? <p className="text-kairikos-danger">Ojo: choca con {r.clashesWith.join(', ')}.</p> : null}
      <div className="flex flex-wrap gap-2 pt-1">
        {r.status === 'pending' ? (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => act('accept', {}, 'Aceptada. Le hemos enviado al huésped el enlace para pagar el depósito.')}>
              Aceptar
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => act('decline', { reason: 'unavailable' }, 'Rechazada. Se ha avisado al huésped.')}>
              Rechazar
            </button>
          </>
        ) : null}
        {r.status === 'accepted' || r.status === 'confirmed' ? (
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              if (window.confirm('¿Cancelar esta reserva? Se avisa al huésped. Si pagó el depósito, la devolución la haces tú desde Stripe.')) {
                void act('cancel', {}, 'Cancelada. Se ha avisado al huésped.');
              }
            }}
          >
            Cancelar
          </button>
        ) : null}
      </div>
      <Notice message={message} />
    </article>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-kairikos-muted">{hint}</span> : null}
    </label>
  );
}

function VillaCard({ villa }: { villa: VillasPanelData['villas'][number] }) {
  const { busy, message, run } = useAction();
  const [seasons, setSeasons] = useState(villa.seasons.map((s) => ({ ...s, price: fromCents(s.nightlyCents) })));
  const [feed, setFeed] = useState({ label: 'Airbnb', url: '' });
  const [block, setBlock] = useState({ start: '', end: '', note: '' });

  async function saveFields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run('PATCH', `/api/portal/villas/villas/${villa.id}`, {
      name: String(f.get('name')),
      maxGuests: Number(f.get('maxGuests')),
      nightlyCents: toCents(String(f.get('nightly'))),
      minNights: Number(f.get('minNights')),
      cleaningFeeCents: toCents(String(f.get('cleaning') || '0')),
      vatRateBps: Math.round(Number(String(f.get('vat')).replace(',', '.')) * 100),
      touristTaxCents: toCents(String(f.get('tax') || '0')),
      isActive: f.get('isActive') === 'on',
    });
  }

  return (
    <article className="card space-y-5 text-sm">
      <form onSubmit={saveFields} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{villa.name}</h3>
          <span className="text-xs text-kairikos-muted">
            En la web: <code>?unidad={villa.slug}</code>
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Nombre">
            <input className="input" name="name" defaultValue={villa.name} required />
          </Field>
          <Field label="Huéspedes máx.">
            <input className="input" name="maxGuests" type="number" min={1} max={40} defaultValue={villa.maxGuests} required />
          </Field>
          <Field label="Precio base / noche (€)">
            <input className="input" name="nightly" inputMode="decimal" defaultValue={fromCents(villa.nightlyCents)} required />
          </Field>
          <Field label="Estancia mínima (noches)">
            <input className="input" name="minNights" type="number" min={1} max={30} defaultValue={villa.minNights} required />
          </Field>
          <Field label="Limpieza (€ por estancia)">
            <input className="input" name="cleaning" inputMode="decimal" defaultValue={fromCents(villa.cleaningFeeCents)} />
          </Field>
          <Field label="IVA incluido (%)">
            <input className="input" name="vat" inputMode="decimal" defaultValue={villa.vatRateBps / 100} />
          </Field>
          <Field label="Tasa turística (€ adulto/noche)" hint="0 si tu comunidad no la tiene.">
            <input className="input" name="tax" inputMode="decimal" defaultValue={fromCents(villa.touristTaxCents)} />
          </Field>
          <label className="flex items-center gap-2 pt-6">
            <input type="checkbox" name="isActive" defaultChecked={villa.isActive} /> Visible en la web
          </label>
        </div>
        <button className="btn-primary" disabled={busy}>
          Guardar villa
        </button>
      </form>

      <div>
        <h4 className="font-semibold">Temporadas</h4>
        <p className="text-xs text-kairikos-muted">De la primera a la última noche, ambas incluidas. La estancia mínima es la de la noche de llegada.</p>
        <table className="mt-2 w-full text-left">
          <thead className="text-xs text-kairikos-muted">
            <tr>
              <th className="py-1 font-normal">Nombre</th>
              <th className="font-normal">Desde</th>
              <th className="font-normal">Hasta</th>
              <th className="font-normal">€ / noche</th>
              <th className="font-normal">Mín. noches</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {seasons.map((s, i) => (
              <tr key={i}>
                {(['name', 'startDate', 'endDate', 'price', 'minNights'] as const).map((key) => (
                  <td key={key} className="py-1 pr-2">
                    <input
                      aria-label={key}
                      className="input"
                      type={key === 'startDate' || key === 'endDate' ? 'date' : key === 'minNights' ? 'number' : 'text'}
                      value={String(s[key])}
                      onChange={(e) => setSeasons((all) => all.map((x, j) => (j === i ? { ...x, [key]: key === 'minNights' ? Number(e.target.value) : e.target.value } : x)))}
                    />
                  </td>
                ))}
                <td>
                  <button type="button" className="btn-ghost" onClick={() => setSeasons((all) => all.filter((_, j) => j !== i))}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              setSeasons((all) => [...all, { name: 'Temporada alta', startDate: '', endDate: '', price: fromCents(villa.nightlyCents), nightlyCents: villa.nightlyCents, minNights: villa.minNights }])
            }
          >
            Añadir temporada
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              run('PATCH', `/api/portal/villas/villas/${villa.id}`, {
                seasons: seasons.map((s) => ({ name: s.name, startDate: s.startDate, endDate: s.endDate, nightlyCents: toCents(String(s.price)), minNights: Number(s.minNights) })),
              })
            }
          >
            Guardar temporadas
          </button>
        </div>
      </div>

      <div>
        <h4 className="font-semibold">Calendarios</h4>
        <p className="text-xs text-kairikos-muted">
          Pega en Airbnb y Booking («Importar calendario») esta dirección, para que vean lo que se reserva aquí:
        </p>
        <input className="input mt-1 font-mono text-xs" readOnly value={villa.icalExportUrl} onFocus={(e) => e.currentTarget.select()} aria-label="URL del calendario de salida" />
        <p className="mt-3 text-xs text-kairikos-muted">Y aquí, la dirección de exportación de cada plataforma (se leen cada 30 minutos y al aceptar una solicitud):</p>
        <ul className="mt-1 space-y-1">
          {villa.feeds.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{f.label}</strong> · {f.host} ·{' '}
                {f.lastStatus === 'ok'
                  ? `${f.eventCount} bloqueos, leído ${f.lastSyncedAt ? new Date(f.lastSyncedAt).toLocaleString('es-ES') : ''}`
                  : f.lastStatus === 'error'
                    ? <span className="text-kairikos-danger">error al leer ({f.lastError})</span>
                    : 'sin leer todavía'}
              </span>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('POST', `/api/portal/villas/villas/${villa.id}/calendar`, { action: 'remove_feed', feedId: f.id }, 'Quitado.')}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 grid gap-2 sm:grid-cols-[10rem,1fr,auto,auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await run('POST', `/api/portal/villas/villas/${villa.id}/calendar`, { action: 'add_feed', ...feed }, 'Calendario añadido y leído.');
            if (done) setFeed({ label: 'Airbnb', url: '' });
          }}
        >
          <select className="input" value={feed.label} onChange={(e) => setFeed({ ...feed, label: e.target.value })} aria-label="Plataforma">
            <option>Airbnb</option>
            <option>Booking</option>
            <option>Vrbo</option>
            <option>Otro</option>
          </select>
          <input className="input" type="url" placeholder="https://www.airbnb.es/calendar/ical/….ics" value={feed.url} onChange={(e) => setFeed({ ...feed, url: e.target.value })} required aria-label="URL de exportación iCal" />
          <button className="btn-primary" disabled={busy}>
            Añadir
          </button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('POST', `/api/portal/villas/villas/${villa.id}/calendar`, { action: 'sync' }, 'Calendarios leídos.')}>
            Leer ahora
          </button>
        </form>
      </div>

      <div>
        <h4 className="font-semibold">Noches cerradas a mano</h4>
        <ul className="mt-1 space-y-1">
          {villa.manualBlocks.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {day(b.start)} → {day(b.end)} {b.note ? `· ${b.note}` : ''}
              </span>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('POST', `/api/portal/villas/villas/${villa.id}/calendar`, { action: 'remove_block', blockId: b.id }, 'Abierto.')}>
                Abrir
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 grid gap-2 sm:grid-cols-[auto,auto,1fr,auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await run('POST', `/api/portal/villas/villas/${villa.id}/calendar`, { action: 'add_block', ...block }, 'Cerrado.');
            if (done) setBlock({ start: '', end: '', note: '' });
          }}
        >
          <input className="input" type="date" value={block.start} onChange={(e) => setBlock({ ...block, start: e.target.value })} required aria-label="Primera noche" />
          <input className="input" type="date" value={block.end} onChange={(e) => setBlock({ ...block, end: e.target.value })} required aria-label="Día de salida" />
          <input className="input" placeholder="Motivo (solo lo ves tú)" value={block.note} onChange={(e) => setBlock({ ...block, note: e.target.value })} aria-label="Motivo" />
          <button className="btn-ghost" disabled={busy}>
            Cerrar fechas
          </button>
        </form>
      </div>
      <Notice message={message} />
    </article>
  );
}

function NewVillaForm() {
  const { busy, message, run } = useAction();
  return (
    <form
      className="card grid gap-3 text-sm sm:grid-cols-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const done = await run(
          'POST',
          '/api/portal/villas/villas',
          {
            name: String(f.get('name')),
            maxGuests: Number(f.get('maxGuests')),
            nightlyCents: toCents(String(f.get('nightly'))),
            minNights: Number(f.get('minNights')),
            cleaningFeeCents: toCents(String(f.get('cleaning') || '0')),
          },
          'Villa creada.',
        );
        if (done) form.reset();
      }}
    >
      <h3 className="font-semibold sm:col-span-5">Añadir una villa</h3>
      <Field label="Nombre">
        <input className="input" name="name" required minLength={2} />
      </Field>
      <Field label="Huéspedes máx.">
        <input className="input" name="maxGuests" type="number" min={1} max={40} defaultValue={4} required />
      </Field>
      <Field label="Precio / noche (€)">
        <input className="input" name="nightly" inputMode="decimal" required />
      </Field>
      <Field label="Estancia mínima">
        <input className="input" name="minNights" type="number" min={1} max={30} defaultValue={3} required />
      </Field>
      <Field label="Limpieza (€)">
        <input className="input" name="cleaning" inputMode="decimal" defaultValue="0" />
      </Field>
      <div className="sm:col-span-5">
        <button className="btn-primary" disabled={busy}>
          Crear villa
        </button>
        <Notice message={message} />
      </div>
    </form>
  );
}

function SettingsForm({ settings }: { settings: VillasPanelData['settings'] }) {
  const { busy, message, run } = useAction();
  return (
    <form
      className="card grid gap-3 text-sm sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run('PATCH', '/api/portal/villas', {
          businessName: String(f.get('businessName')),
          ownerEmail: String(f.get('ownerEmail') ?? ''),
          ownerPhone: String(f.get('ownerPhone') ?? ''),
          siteUrl: String(f.get('siteUrl') ?? ''),
          timeZone: String(f.get('timeZone')),
          depositPercent: Number(f.get('depositPercent')),
          confirmHours: Number(f.get('confirmHours')),
          paymentHours: Number(f.get('paymentHours')),
          balanceNote: String(f.get('balanceNote') ?? ''),
          cancellationNote: String(f.get('cancellationNote') ?? ''),
        });
      }}
    >
      <Field label="Nombre que firma los correos al huésped">
        <input className="input" name="businessName" defaultValue={settings.businessName} required />
      </Field>
      <Field label="Correo para los avisos" hint="Vacío = el de tu cuenta.">
        <input className="input" name="ownerEmail" type="email" defaultValue={settings.ownerEmail ?? ''} />
      </Field>
      <Field label="Teléfono para el huésped (opcional)">
        <input className="input" name="ownerPhone" defaultValue={settings.ownerPhone ?? ''} />
      </Field>
      <Field label="Tu web" hint="El huésped vuelve aquí desde la página de su solicitud.">
        <input className="input" name="siteUrl" type="url" defaultValue={settings.siteUrl ?? ''} />
      </Field>
      <Field label="Zona horaria">
        <select className="input" name="timeZone" defaultValue={settings.timeZone}>
          <option value="Europe/Madrid">Península y Baleares</option>
          <option value="Atlantic/Canary">Canarias</option>
        </select>
      </Field>
      <Field label="Depósito (% del total)" hint="Entre 10 y 100.">
        <input className="input" name="depositPercent" type="number" min={10} max={100} defaultValue={settings.depositPercent} />
      </Field>
      <Field label="Horas para contestar una solicitud" hint="Entre 2 y 72. La web dice «el anfitrión confirma en menos de N horas».">
        <input className="input" name="confirmHours" type="number" min={2} max={72} defaultValue={settings.confirmHours} />
      </Field>
      <Field label="Horas del huésped para pagar el depósito" hint="Entre 12 y 168.">
        <input className="input" name="paymentHours" type="number" min={12} max={168} defaultValue={settings.paymentHours} />
      </Field>
      <Field label="El resto del pago" hint="Una frase: cuándo y cómo. P. ej.: «El resto se paga a la llegada, en efectivo o con tarjeta.»">
        <textarea className="input" name="balanceNote" rows={2} maxLength={400} defaultValue={settings.balanceNote ?? ''} />
      </Field>
      <Field label="Si el huésped cancela" hint="Una frase con tu política. Se enseña antes de pagar.">
        <textarea className="input" name="cancellationNote" rows={2} maxLength={400} defaultValue={settings.cancellationNote ?? ''} />
      </Field>
      <div className="sm:col-span-2">
        <button className="btn-primary" disabled={busy}>
          Guardar condiciones
        </button>
        <Notice message={message} />
      </div>
    </form>
  );
}

function StripeForm({ stripe }: { stripe: VillasPanelData['stripe'] }) {
  const { busy, message, run } = useAction();
  const [key, setKey] = useState('');
  return (
    <div className="card space-y-3 text-sm">
      <p>
        {stripe.configured ? (
          <>
            Clave guardada: <code>…{stripe.hint}</code> ({stripe.mode === 'test' ? 'modo de prueba' : 'modo real'}).
          </>
        ) : (
          'Todavía no hay clave.'
        )}{' '}
        {!stripe.liveAllowed ? 'Por ahora solo se aceptan claves de prueba: no se cobra dinero real.' : null}
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const done = await run('PUT', '/api/portal/villas/stripe', { secretKey: key }, 'Clave comprobada y guardada.');
          if (done) setKey('');
        }}
      >
        <input className="input min-w-[16rem] flex-1 font-mono" type="password" autoComplete="off" placeholder="rk_test_…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Clave de Stripe" required />
        <button className="btn-primary" disabled={busy}>
          Guardar
        </button>
        {stripe.configured ? (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => run('DELETE', '/api/portal/villas/stripe', undefined, 'Clave borrada.')}>
            Borrar
          </button>
        ) : null}
      </form>
      <Notice message={message} />
    </div>
  );
}
