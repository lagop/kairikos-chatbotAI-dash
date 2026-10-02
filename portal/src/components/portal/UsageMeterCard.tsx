import { BuyUsagePackButton } from './BuyUsagePackButton';

// =============================================================================
// Plan de precios del 01/10/2026 — cuánto lleva gastado este mes un servicio
// con tope (mensajes del chatbot, negocios de prospección) y, si hace falta,
// el pack para ampliarlo.
//
// Hasta esta fecha el cliente no veía su consumo en ningún sitio: se enteraba
// del tope cuando el bot dejaba de contestar. Componente de servidor: no
// tiene estado, solo enseña lo que ya calculó la página.
// =============================================================================

export interface UsageMeterCardProps {
  title: string;
  /** «mensajes», «negocios». */
  unit: string;
  used: number;
  cap: number;
  packRemaining: number;
  /** null cuando el pack no está a la venta (aún no creado en Stripe). */
  offer: { packCode: 'pack_chatbot_messages' | 'pack_prospecting_leads'; label: string; price: string } | null;
  clientProductId: string | null;
  /** ?pack=ok|cancelado de la vuelta de Stripe. */
  packReturn?: string | null;
}

const fmt = (n: number) => n.toLocaleString('es-ES');

export function UsageMeterCard(props: UsageMeterCardProps) {
  const pct = props.cap > 0 ? Math.min(100, Math.round((props.used / props.cap) * 100)) : 0;
  const exhausted = props.used >= props.cap && props.packRemaining <= 0;
  const near = !exhausted && pct >= 80;

  return (
    <section className="card space-y-3" aria-label={props.title} data-testid="usage-meter-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{props.title}</p>
        <p className="text-sm text-kairikos-muted" data-testid="usage-meter-figures">
          {fmt(props.used)} de {fmt(props.cap)} {props.unit} este mes
        </p>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-kairikos-surface2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={props.cap}
        aria-valuenow={props.used}
      >
        <div
          className={`h-full ${exhausted ? 'bg-kairikos-danger' : near ? 'bg-kairikos-warning' : 'bg-kairikos-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {props.packRemaining > 0 ? (
        <p className="text-xs text-kairikos-muted" data-testid="usage-meter-pack">
          Además te quedan {fmt(props.packRemaining)} {props.unit} de packs. No caducan: se usan cuando se acaba el cupo
          del mes.
        </p>
      ) : null}
      {exhausted ? (
        <p className="text-sm text-kairikos-danger" data-testid="usage-meter-exhausted">
          Has llegado al tope de este mes. Hasta el día 1 no hay más, salvo que añadas un pack.
        </p>
      ) : near ? (
        <p className="text-sm text-kairikos-warning">Te queda poco del cupo de este mes.</p>
      ) : null}
      {props.packReturn === 'ok' ? (
        <p className="text-sm text-kairikos-accent2" role="status">
          Pago recibido. El saldo aparece aquí en cuanto Stripe lo confirma, normalmente en unos segundos.
        </p>
      ) : null}
      {props.offer && (exhausted || near || props.packReturn === 'cancelado') ? (
        <BuyUsagePackButton
          packCode={props.offer.packCode}
          clientProductId={props.clientProductId}
          label={`Añadir ${props.offer.label} · ${props.offer.price}`}
        />
      ) : props.offer ? (
        <p className="text-xs text-kairikos-muted">
          Si alguna vez se te queda corto, puedes añadir {props.offer.label} por {props.offer.price}.
        </p>
      ) : null}
    </section>
  );
}
