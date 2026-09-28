'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Producto Web, Fase 1 — el cliente edita el contenido de su web.
//
// La regla que gobierna esta pantalla: el cliente cambia CONTENIDO, no
// ESTRUCTURA. Textos, servicios, teléfono y dirección, sí; plantilla, orden
// de secciones y colores, no. Así no puede romperse su propia web un
// domingo, que es justo la llamada que no queremos recibir. Cambiar de
// plantilla se pide y lo hace el operador.
//
// Guardar y publicar son DOS botones distintos, a propósito. Se corrigen
// cosas a ratos y lo que está en internet no cambia hasta que se decide.
// =============================================================================

export interface WebsiteEditorData {
  clientProductId: string;
  status: string;
  lastPublishedAt: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  copy: {
    headline: string;
    subheadline: string;
    about: string;
    services: { name: string; description: string }[];
    callToAction: string;
  };
}

const ERROR_LABEL: Record<string, string> = {
  publish_not_configured: 'Todavía no podemos publicar: nos falta un dato de tu alojamiento. Ya lo estamos mirando.',
  publish_failed: 'No hemos podido publicar ahora mismo. Lo estamos revisando; tus cambios están guardados.',
  invalid_body: 'Revisa los campos: el titular no puede quedar vacío.',
  not_found: 'No encontramos tu web. Recarga la página.',
  internal_error: 'Algo falló por nuestra parte. Tus cambios no se han perdido.',
};

export function WebsiteEditorCard({ data }: { data: WebsiteEditorData }) {
  const router = useRouter();
  const [copy, setCopy] = useState(data.copy);
  const [contact, setContact] = useState({
    phone: data.phone ?? '',
    address: data.address ?? '',
    city: data.city ?? '',
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function edit<K extends keyof typeof copy>(key: K, value: (typeof copy)[K]) {
    setCopy((c) => ({ ...c, [key]: value }));
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    setBusy('save');
    setError(null);
    const res = await fetch(`/api/portal/website/${data.clientProductId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: contact.phone || null,
        address: contact.address || null,
        city: contact.city || null,
        copy,
      }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_LABEL[body.error ?? 'internal_error'] ?? ERROR_LABEL.internal_error);
      return;
    }
    setDirty(false);
    setMessage('Guardado. Todavía no está en internet: pulsa «Publicar» cuando quieras que se vea.');
    router.refresh();
  }

  async function publish() {
    setBusy('publish');
    setError(null);
    const res = await fetch(`/api/portal/website/${data.clientProductId}/publish`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_LABEL[body.error ?? 'internal_error'] ?? ERROR_LABEL.internal_error);
      return;
    }
    setMessage('Publicado. Tus cambios ya se ven en tu web.');
    router.refresh();
  }

  return (
    <section className="card space-y-5" data-testid="website-editor">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Tu web</h2>
          <span className={data.status === 'published' ? 'pill-success' : 'pill-warning'}>
            {data.status === 'published' ? 'Publicada' : 'Sin publicar'}
          </span>
          {dirty ? <span className="pill-warning">Cambios sin publicar</span> : null}
        </div>
        <p className="mt-1 text-sm text-kairikos-muted">
          Cambia lo que quieras y pulsa «Publicar» cuando esté listo. Hasta entonces, en internet se sigue viendo
          lo anterior.
        </p>
      </header>

      <div className="space-y-3">
        <label className="block text-sm">
          Titular
          <input
            className="input mt-1 w-full"
            value={copy.headline}
            maxLength={120}
            onChange={(e) => edit('headline', e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Frase de apoyo
          <input
            className="input mt-1 w-full"
            value={copy.subheadline}
            maxLength={400}
            onChange={(e) => edit('subheadline', e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Sobre el negocio
          <textarea
            className="input mt-1 w-full"
            rows={4}
            value={copy.about}
            maxLength={1200}
            onChange={(e) => edit('about', e.target.value)}
          />
        </label>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Servicios</h3>
        {copy.services.map((service, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <input
              className="input"
              value={service.name}
              maxLength={80}
              placeholder="Nombre"
              onChange={(e) =>
                edit(
                  'services',
                  copy.services.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)),
                )
              }
            />
            <input
              className="input"
              value={service.description}
              maxLength={300}
              placeholder="Una frase"
              onChange={(e) =>
                edit(
                  'services',
                  copy.services.map((s, i) => (i === index ? { ...s, description: e.target.value } : s)),
                )
              }
            />
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={() =>
                edit(
                  'services',
                  copy.services.filter((_, i) => i !== index),
                )
              }
            >
              Quitar
            </button>
          </div>
        ))}
        {copy.services.length < 12 ? (
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => edit('services', [...copy.services, { name: '', description: '' }])}
          >
            + Añadir servicio
          </button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          Teléfono
          <input
            className="input mt-1 w-full"
            value={contact.phone}
            onChange={(e) => {
              setContact((c) => ({ ...c, phone: e.target.value }));
              setDirty(true);
            }}
          />
        </label>
        <label className="text-sm">
          Dirección
          <input
            className="input mt-1 w-full"
            value={contact.address}
            onChange={(e) => {
              setContact((c) => ({ ...c, address: e.target.value }));
              setDirty(true);
            }}
          />
        </label>
        <label className="text-sm">
          Ciudad
          <input
            className="input mt-1 w-full"
            value={contact.city}
            onChange={(e) => {
              setContact((c) => ({ ...c, city: e.target.value }));
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy !== null || !copy.headline.trim()}
          onClick={save}
          data-testid="website-editor-save"
        >
          {busy === 'save' ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || dirty}
          onClick={publish}
          title={dirty ? 'Guarda los cambios antes de publicarlos.' : undefined}
          data-testid="website-editor-publish"
        >
          {busy === 'publish' ? 'Publicando…' : 'Publicar'}
        </button>
        {data.lastPublishedAt ? (
          <span className="text-xs text-kairikos-muted">
            Última publicación: {new Date(data.lastPublishedAt).toLocaleString('es-ES')}
          </span>
        ) : null}
      </div>

      {message ? <p className="text-sm text-kairikos-success">{message}</p> : null}
      {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}

      <p className="text-xs text-kairikos-muted">
        ¿Quieres otro diseño, otra estructura o más páginas? Escríbenos y lo cambiamos nosotros.
      </p>
    </section>
  );
}
