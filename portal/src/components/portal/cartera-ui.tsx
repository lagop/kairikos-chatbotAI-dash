'use client';

import type { ReactNode } from 'react';

// =============================================================================
// Cartera — piezas comunes del panel (/portal/cartera): la llamada a la API,
// el aviso de la última acción y los campos, con el mismo aspecto que
// VillasPanel. Las reglas no viven aquí: las decide lib/cartera/home-rules.ts
// en el servidor y vuelven en la respuesta.
// =============================================================================

export type NoticeMessage = { tone: 'ok' | 'error'; text: string } | null;

export const ERROR_TEXT: Record<string, string> = {
  read_only: 'El servicio está dado de baja: el panel es de solo lectura.',
  not_contracted: 'La cartera no está activa en tu cuenta.',
  not_found: 'Esa casa ya no existe. Recarga la página.',
  refs_exhausted: 'No quedan referencias libres para esa operación. Habla con soporte.',
  invalid_status: 'Ese estado no vale para esta casa.',
  published_to_draft: 'Una casa ya publicada no vuelve a borrador: retírala con su estado (vendida, alquilada).',
  not_a_draft: 'Solo se borra un borrador que nunca se ha publicado. Una casa publicada se retira con su estado.',
  too_large: 'La ficha es demasiado larga. Acorta los textos.',
  invalid_body: 'Revisa los campos.',
  invalid_order: 'Las fotos han cambiado mientras las ordenabas. Recarga la página.',
  not_an_image: 'Ese archivo no es una foto JPEG, PNG o WebP.',
  too_big_dimensions: 'La foto es demasiado grande (como mucho 2.400 px por lado).',
  too_many_photos: 'Como mucho 40 fotos por casa.',
  storage_not_configured: 'Las fotos no se pueden guardar ahora mismo. Habla con soporte.',
  nothing_to_translate: 'Escribe primero los textos en español.',
  too_many_requests: 'Has pedido muchas traducciones seguidas. Prueba dentro de un rato.',
  translation_failed: 'La traducción ha fallado. Inténtalo de nuevo.',
  ai_not_configured: 'La traducción con IA no está disponible ahora mismo.',
  unreadable: 'No se ha podido leer la foto. Prueba con un JPEG o un PNG.',
};

export async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export function errorMessage(data: Record<string, unknown>): string {
  const code = typeof data.error === 'string' ? data.error : 'error';
  return ERROR_TEXT[code] ?? `No se ha podido guardar (${code}).`;
}

export function Notice({ message }: { message: NoticeMessage }) {
  if (!message) return null;
  return (
    <p role="status" className={`text-sm ${message.tone === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}>
      {message.text}
    </p>
  );
}

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="mt-1 max-w-2xl text-sm text-kairikos-muted">{description}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-kairikos-muted">{hint}</span> : null}
    </label>
  );
}

const eurFormat = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** «350.000 €» en venta, «1.200 €/mes» en alquiler. */
export function priceText(operation: string, price: number | null): string {
  if (price === null) return '—';
  return operation === 'alquiler' ? `${eurFormat.format(price)}/mes` : eurFormat.format(price);
}

export function dateTimeText(iso: string): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso));
}

export function dayText(isoDate: string): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** La baja: el panel se ve, pero no se toca. */
export function ReadOnlyBanner({ graceEndsAt }: { graceEndsAt: string | null }) {
  return (
    <p className="card mt-6 border-kairikos-warning/50 text-sm" data-testid="cartera-read-only">
      {graceEndsAt ? (
        <>
          El servicio está dado de baja. Tus casas siguen aquí, en solo lectura, hasta el <strong>{dateTimeText(graceEndsAt)}</strong>; después se borran.
        </>
      ) : (
        <>El servicio no está activo ahora mismo: puedes ver tus casas, pero no cambiarlas. Para reactivarlo, habla con soporte.</>
      )}
    </p>
  );
}
