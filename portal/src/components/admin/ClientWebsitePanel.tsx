'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from '@/components/portal/TotpStepUpModal';

// =============================================================================
// Producto Web, Fase 1 — el panel con el que el operador entrega una web.
//
// El recorrido completo cabe en esta tarjeta y en ese orden: dar de alta el
// sitio (normalmente desde el borrador que el prospecto ya vio), revisar la
// vista previa, pegar la credencial de SFTP de su alojamiento y publicar.
//
// Dos decisiones que se ven en la pantalla:
//
// - Guardar NO publica. Se corrigen textos las veces que haga falta y el
//   cliente sigue viendo lo último publicado hasta que alguien pulsa el
//   botón. Una errata a medias no sale a producción sola.
// - La credencial pide segundo factor; publicar, no. La credencial es la
//   llave del servidor de un tercero; publicar es el día a día, y exigir el
//   código cada vez que se corrige una coma acabaría con el operador
//   apuntándoselo en un papel.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_host: 'Ese host no vale: no puede ser localhost, una IP privada ni un nombre sin punto.',
  credential_missing: 'Antes de publicar hay que guardar la credencial de SFTP.',
  website_not_found: 'No se encontró el sitio. Recarga la página.',
  build_failed: 'No se pudo generar la página. Revisa los textos.',
  invalid_body: 'Revisa los campos del formulario.',
  totp_required: 'Hace falta el código de tu aplicación de autenticación.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor.',
};

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorText(code: unknown): string {
  const key = typeof code === 'string' ? code : 'internal_error';
  // Un fallo de SFTP llega con el mensaje del servidor del cliente ("No such
  // file", "Permission denied"): se enseña tal cual, porque es lo único que
  // de verdad dice qué arreglar.
  return ERROR_LABEL[key] ?? `No se pudo publicar: ${key}`;
}

export interface ClientWebsiteView {
  id: string;
  businessName: string;
  status: string;
  themeKey: string;
  lastPublishedAt: string | null;
  lastPublishError: string | null;
  credential: { host: string; username: string; remotePath: string; savedAt: string } | null;
}

export function ClientWebsitePanel({
  clientProductId,
  website,
  draftLeads,
}: {
  clientProductId: string;
  website: ClientWebsiteView | null;
  /** Prospectos de este cliente que ya tienen borrador, para poder crear el
   *  sitio a partir de la página que el negocio ya vio. */
  draftLeads: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totpOpen, setTotpOpen] = useState(false);
  const [form, setForm] = useState({
    host: website?.credential?.host ?? '',
    port: '22',
    username: website?.credential?.username ?? '',
    password: '',
    remotePath: website?.credential?.remotePath ?? '/public_html',
  });

  async function createWebsite(fromLeadId?: string) {
    setBusy('create');
    setError(null);
    const res = await fetch('/api/admin/portal/websites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientProductId, fromLeadId, businessName: fromLeadId ? undefined : 'Nuevo sitio' }),
    });
    setBusy(null);
    if (!res.ok) {
      setError(errorText((await safeJson(res)).error));
      return;
    }
    router.refresh();
  }

  async function saveCredential() {
    setBusy('credential');
    setError(null);
    const res = await fetch(`/api/admin/portal/websites/${website?.id}/credential`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: form.host,
        port: Number(form.port) || 22,
        username: form.username,
        password: form.password,
        remotePath: form.remotePath,
      }),
    });
    setBusy(null);
    const body = await safeJson(res);
    if (res.status === 401 || body.error === 'totp_required' || body.error === 'totp_stale') {
      setTotpOpen(true);
      return;
    }
    if (!res.ok) {
      setError(errorText(body.error));
      return;
    }
    // La contraseña se borra del formulario en cuanto se guarda, salga bien
    // o mal: no tiene por qué seguir en pantalla ni un segundo más.
    setForm((f) => ({ ...f, password: '' }));
    setMessage('Credencial guardada.');
    router.refresh();
  }

  async function publish() {
    setBusy('publish');
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/admin/portal/websites/${website?.id}/publish`, { method: 'POST' });
    setBusy(null);
    const body = await safeJson(res);
    if (!res.ok) {
      setError(errorText(body.error));
      router.refresh();
      return;
    }
    setMessage(`Publicado: ${String(body.filesUploaded ?? 0)} archivos subidos.`);
    router.refresh();
  }

  if (!website) {
    return (
      <div className="space-y-3" data-testid="client-website-empty">
        <p className="text-sm text-kairikos-muted">
          Este proyecto todavía no tiene sitio. Créalo desde el borrador que el negocio ya vio, o en blanco.
        </p>
        <div className="flex flex-wrap gap-2">
          {draftLeads.map((lead) => (
            <button
              key={lead.id}
              type="button"
              className="btn-primary text-sm"
              disabled={busy !== null}
              onClick={() => createWebsite(lead.id)}
            >
              Desde el borrador de {lead.name}
            </button>
          ))}
          <button type="button" className="btn-ghost text-sm" disabled={busy !== null} onClick={() => createWebsite()}>
            Crear en blanco
          </button>
        </div>
        {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="client-website-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className={website.status === 'published' ? 'pill-success' : 'pill-warning'}>
          {website.status === 'published' ? 'Publicado' : 'Borrador'}
        </span>
        {website.lastPublishedAt ? (
          <span className="text-xs text-kairikos-muted">
            Última publicación: {new Date(website.lastPublishedAt).toLocaleString('es-ES')}
          </span>
        ) : null}
        <a
          href={`/api/admin/portal/websites/${website.id}/preview`}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost ml-auto text-sm"
        >
          Ver cómo va a quedar
        </a>
      </div>

      {website.lastPublishError ? (
        <p className="text-sm text-kairikos-danger" data-testid="client-website-last-error">
          La última publicación falló: {website.lastPublishError}
        </p>
      ) : null}

      <div className="rounded-md border border-kairikos-border p-4">
        <h3 className="text-sm font-semibold">Alojamiento del cliente (SFTP)</h3>
        <p className="mt-1 text-xs text-kairikos-muted">
          Solo SFTP. FTP a secas manda la contraseña en texto plano por la red y esto es la llave de su web.
          {website.credential ? ` Guardada el ${new Date(website.credential.savedAt).toLocaleDateString('es-ES')}.` : ''}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Host
            <input
              className="input mt-1 w-full"
              value={form.host}
              placeholder="sftp.sudominio.es"
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            Puerto
            <input
              className="input mt-1 w-full"
              value={form.port}
              onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            Usuario
            <input
              className="input mt-1 w-full"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            Contraseña
            <input
              type="password"
              className="input mt-1 w-full"
              value={form.password}
              placeholder={website.credential ? 'Guardada — escribe para cambiarla' : ''}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Directorio remoto
            <input
              className="input mt-1 w-full"
              value={form.remotePath}
              placeholder="/public_html"
              onChange={(e) => setForm((f) => ({ ...f, remotePath: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="btn-ghost mt-3 text-sm"
          disabled={busy !== null || !form.host || !form.username || !form.password}
          onClick={() => saveCredential()}
          data-testid="client-website-save-credential"
        >
          {busy === 'credential' ? 'Guardando…' : 'Guardar credencial'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || !website.credential}
          onClick={publish}
          data-testid="client-website-publish"
        >
          {busy === 'publish' ? 'Publicando…' : 'Publicar en su alojamiento'}
        </button>
        {!website.credential ? (
          <span className="text-xs text-kairikos-muted">Falta la credencial de SFTP.</span>
        ) : null}
      </div>

      {message ? <p className="text-sm text-kairikos-success">{message}</p> : null}
      {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}

      {totpOpen ? (
        <TotpStepUpModal
          onCancel={() => setTotpOpen(false)}
          onVerified={() => {
            // El modal verifica el código contra /api/operator/totp/verify y
            // eso sella la sesión; requireTotpStepUp mira ese sello, no una
            // cabecera. Por eso aquí solo se reintenta.
            setTotpOpen(false);
            void saveCredential();
          }}
        />
      ) : null}
    </div>
  );
}
