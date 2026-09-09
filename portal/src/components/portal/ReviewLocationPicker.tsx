import Link from 'next/link';
import type { ReviewLocation } from '@/lib/review-locations';

// =============================================================================
// Fase 3 — el selector de local del producto de reseñas.
//
// **No se dibuja con un solo local**, que es el caso de casi todos los
// clientes: un selector de una sola opción no es una elección, es un
// control que sobra en la pantalla de quien nunca va a tener otro.
//
// Enlaces y no un desplegable con JavaScript: cambiar de local es navegar,
// y así cada local tiene su propia dirección — el cliente puede guardarse
// en marcadores el de la tienda que mira todos los lunes.
// =============================================================================

const STATUS_LABEL: Record<string, string> = {
  active: 'Conectado',
  needs_reconnect: 'Hay que reconectar',
  revoked: 'Desconectado',
};

export function ReviewLocationPicker({
  locations,
  selectedId,
  cap,
}: {
  locations: ReviewLocation[];
  selectedId: string | null;
  /** Ubicaciones que incluye su tarifa, para decirle cuántas le quedan. */
  cap: number;
}) {
  if (locations.length <= 1) return null;

  return (
    <section className="card space-y-3" aria-label="Tus locales" data-testid="review-location-picker">
      <div>
        <p className="text-sm font-semibold">Tus locales</p>
        <p className="text-xs text-kairikos-muted">
          Las reseñas, las respuestas y las campañas son de cada local por separado. Estás viendo{' '}
          {locations.length} de {cap} que incluye tu plan.
        </p>
      </div>

      <ul className="flex flex-wrap gap-2" data-testid="review-location-list">
        {locations.map((location) => {
          const isSelected = location.id === selectedId;
          return (
            <li key={location.id}>
              <Link
                href={`/portal/resenas?local=${location.id}`}
                aria-current={isSelected ? 'page' : undefined}
                data-testid="review-location-option"
                data-selected={isSelected ? 'true' : 'false'}
                className={`flex flex-col rounded-xl border px-3.5 py-2 transition ${
                  isSelected
                    ? 'border-kairikos-accent bg-kairikos-accent/10'
                    : 'border-kairikos-border bg-kairikos-surface2 hover:border-kairikos-accent'
                }`}
              >
                <span className="text-sm font-medium text-kairikos-text">{location.locationName}</span>
                <span className="text-xs text-kairikos-muted">
                  {STATUS_LABEL[location.status] ?? location.status}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
