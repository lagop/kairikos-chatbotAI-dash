'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_CONTACTOS_POR_DIA as MAX_POR_DIA,
  normalizarPresentacion,
  parametrosDelPaso,
  PRESENTACION_MAX,
  primerMensaje,
  PROSPECTO_DE_EJEMPLO,
  rellenarPlantilla,
  SEGUIMIENTOS,
} from '@/lib/prospecting-presentacion';

// =============================================================================
// Prospección con IA, Fase A — the client's own target-profile settings:
// what kind of business, and where. Deliberately self-serve — see
// prospecting-campaign route's header for why this is NOT an
// operator-managed setting. Same shape as ConversationDigestsPanel.tsx:
// controlled inputs, one PATCH, router.refresh() on success.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa los datos — falta el rubro o la zona.',
  busqueda_a_medias: 'Cada búsqueda necesita un rubro y una zona. Completa o quita la que está a medias.',
  demasiadas_busquedas: 'Puedes tener hasta 10 búsquedas a la vez.',
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
  not_found: 'Guarda tu perfil de búsqueda antes de activar el contacto automático.',
  presentacion_demasiado_larga: `A qué te dedicas tiene que caber en ${PRESENTACION_MAX} caracteres.`,
  falta_presentacion: 'Escribe a qué te dedicas antes de autorizar: sin eso el primer mensaje no se puede enviar.',
};

/** Hasta cuántas búsquedas deja añadir el formulario. Repite
 *  MAX_SEARCHES_PER_CAMPAIGN de lib/prospecting.ts, que es server-only: la
 *  convención del repositorio es repetir la comprobación en el componente,
 *  nunca importar el lib. La ruta vuelve a comprobarlo. */
const MAX_BUSQUEDAS = 10;

interface SearchRow {
  category: string;
  locationQuery: string;
}

const EMPTY_ROW: SearchRow = { category: '', locationQuery: '' };

export interface ProspectingProfile {
  // Varias combinaciones de rubro y zona desde el 29/09/2026. El radio se
  // fue: nunca llegó a Google.
  searches: SearchRow[];
  // Fase A (2026-09-18) — el contexto del negocio del cliente.
  clientWebsite: string | null;
  businessDescription: string | null;
  idealCustomer: string | null;
  exclusions: string | null;
  // «Nos dedicamos a …», el {{3}} del primer mensaje (28/09/2026).
  presentacion: string | null;
  // Fase C. Solo llega con valor si el consentimiento es de la versión
  // VIGENTE — lo decide la página, que puede leer PROSPECTING_CONSENT_VERSION.
  // Uno de una versión anterior no deja enviar nada, y enseñarlo aquí como
  // «activo» sería mentirle al cliente.
  consentAcknowledgedAt: Date | null;
  autoContactPausedAt: Date | null;
}

interface Suggestion {
  categories: string[];
  locations: string[];
  exclusions: string[];
  businessSummary: string | null;
}

const SUGGEST_NOTE: Record<string, string> = {
  not_enough_context: 'Cuéntanos algo más de tu negocio, o dinos tu web, y te proponemos a quién buscar.',
  no_api_key: 'Las sugerencias no están disponibles ahora mismo. Puedes rellenar el rubro y la zona a mano.',
  suggestion_failed: 'No hemos podido proponerte nada esta vez. Inténtalo de nuevo o rellénalo a mano.',
  invalid_url: 'Esa dirección web no parece válida — lo hemos hecho sin ella.',
  crawl_failed: 'No pudimos leer tu web — lo hemos hecho con lo que nos has contado.',
};

export function ProspectingProfileCard({
  profile,
  businessName,
}: {
  profile: ProspectingProfile | null;
  /** El nombre con el que firman los mensajes: nombreRemitente(), el mismo que usa el envío. */
  businessName: string;
}) {
  const router = useRouter();
  const [searches, setSearches] = useState<SearchRow[]>(
    profile?.searches.length ? profile.searches.map((x) => ({ ...x })) : [{ ...EMPTY_ROW }],
  );
  const [clientWebsite, setClientWebsite] = useState(profile?.clientWebsite ?? '');
  const [businessDescription, setBusinessDescription] = useState(profile?.businessDescription ?? '');
  const [idealCustomer, setIdealCustomer] = useState(profile?.idealCustomer ?? '');
  const [exclusions, setExclusions] = useState(profile?.exclusions ?? '');
  const [presentacion, setPresentacion] = useState(profile?.presentacion ?? '');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentGiven, setConsentGiven] = useState(Boolean(profile?.consentAcknowledgedAt));
  const [autoPaused, setAutoPaused] = useState(Boolean(profile?.autoContactPausedAt));

  const configured = (profile?.searches.length ?? 0) > 0;

  function updateRow(index: number, field: keyof SearchRow, value: string) {
    setSearches((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  function removeRow(index: number) {
    setSearches((rows) => (rows.length === 1 ? [{ ...EMPTY_ROW }] : rows.filter((_, i) => i !== index)));
  }

  /** Una sugerencia de la IA va al primer hueco libre de ese campo, o a una
   *  búsqueda nueva. Nunca pisa lo que el cliente ya escribió. */
  function applySuggestion(field: keyof SearchRow, value: string) {
    setSearches((rows) => {
      const free = rows.findIndex((row) => !row[field].trim());
      if (free >= 0) return rows.map((row, i) => (i === free ? { ...row, [field]: value } : row));
      if (rows.length >= MAX_BUSQUEDAS) return rows;
      return [...rows, { ...EMPTY_ROW, [field]: value }];
    });
  }

  // La vista previa sale de la MISMA función que prepara el parámetro antes
  // de enviarlo, así que enseña lo que de verdad se mandaría — con el «nos
  // dedicamos a» repetido ya quitado, sin el punto final, etc.
  const presentacionLista = normalizarPresentacion(presentacion);
  const presentacionLarga = (presentacionLista?.length ?? 0) > PRESENTACION_MAX;
  const presentacionGuardada = normalizarPresentacion(profile?.presentacion);
  const presentacionSinGuardar = presentacionLista !== presentacionGuardada;
  const mensajes = presentacionLista
    ? [
        { cuando: 'El primer día', texto: primerMensaje({ prospecto: PROSPECTO_DE_EJEMPLO, negocio: businessName, presentacion: presentacionLista }) },
        ...SEGUIMIENTOS.map((s, i) => ({
          cuando: `${s.diasDespues} días después${i === 0 ? ', si no ha contestado' : ', si sigue sin contestar'}`,
          // Los mismos parámetros que el envío para ese paso (i + 2: el 1 es
          // el primer mensaje), para que la vista previa no enseñe un {{3}}.
          texto: rellenarPlantilla(
            s.texto,
            parametrosDelPaso(i + 2, { prospecto: PROSPECTO_DE_EJEMPLO, negocio: businessName, presentacion: presentacionLista }),
          ),
        })),
      ]
    : [];

  /** Pide una propuesta y la enseña. No guarda nada: el cliente elige. */
  async function suggest() {
    setSuggestNote(null);
    setSuggestion(null);
    setSuggesting(true);
    try {
      const res = await fetch('/api/portal/prospecting/campaign/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientWebsite: clientWebsite.trim(),
          businessDescription: businessDescription.trim(),
          idealCustomer: idealCustomer.trim(),
          exclusions: exclusions.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSuggestNote(SUGGEST_NOTE[(body.error as string) ?? ''] ?? SUGGEST_NOTE.suggestion_failed);
        return;
      }
      if (body.skipped) {
        setSuggestNote(SUGGEST_NOTE[body.skipped as string] ?? SUGGEST_NOTE.suggestion_failed);
        return;
      }
      setSuggestion(body.suggestion as Suggestion);
      if (body.websiteError) setSuggestNote(SUGGEST_NOTE[body.websiteError as string] ?? null);
    } catch (err) {
      setSuggestNote(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSuggesting(false);
    }
  }

  /** Guarda el formulario entero. Devuelve si salió bien, para que autorizar
   *  pueda guardar antes la presentación que el cliente está viendo. */
  async function save(): Promise<boolean> {
    setError(null);
    setSaved(false);
    const filled = searches.filter((row) => row.category.trim() || row.locationQuery.trim());
    if (filled.some((row) => !row.category.trim() || !row.locationQuery.trim())) {
      setError(ERROR_LABEL.busqueda_a_medias);
      return false;
    }
    if (filled.length === 0) {
      setError(ERROR_LABEL.invalid_body);
      return false;
    }
    if (presentacionLarga) {
      setError(ERROR_LABEL.presentacion_demasiado_larga);
      return false;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/portal/prospecting/campaign', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searches: filled.map((row) => ({ category: row.category.trim(), locationQuery: row.locationQuery.trim() })),
          clientWebsite: clientWebsite.trim(),
          businessDescription: businessDescription.trim(),
          idealCustomer: idealCustomer.trim(),
          exclusions: exclusions.trim(),
          presentacion: presentacion.trim(),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return false;
      }
      // Lo que quedó guardado de verdad: sin las repetidas ni las vacías, que
      // la ruta descarta. Si no, el formulario seguiría enseñando una fila
      // que no existe.
      const body = (await res.json().catch(() => null)) as { campaign?: { searches?: SearchRow[] } } | null;
      if (body?.campaign?.searches?.length) setSearches(body.campaign.searches.map((row) => ({ ...row })));
      setSaved(true);
      router.refresh();
      return true;
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function toggleConsent(next: boolean) {
    setConsentError(null);
    setConsentBusy(true);
    try {
      // Se autoriza lo que se VE. Si la presentación del campo no es la
      // guardada, se guarda antes; si eso falla, no se autoriza nada — la
      // ruta de consentimiento miraría la versión vieja, y el cliente habría
      // dado permiso para un mensaje distinto del que tenía delante.
      if (next && presentacionSinGuardar && !(await save())) {
        setConsentError('No se pudo guardar tu presentación, así que no hemos activado nada.');
        return;
      }
      const res = await fetch('/api/portal/prospecting/campaign/consent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: next }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setConsentError(ERROR_LABEL[detail?.error] ?? 'No se pudo actualizar el contacto automático.');
        return;
      }
      setConsentGiven(next);
      setAutoPaused(false);
      router.refresh();
    } catch (err) {
      setConsentError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setConsentBusy(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Perfil de prospección" data-testid="prospecting-profile-card">
      <div>
        <p className="text-sm font-semibold">¿A quién buscamos?</p>
        <p className="text-xs text-kairikos-muted">
          {configured
            ? 'Añade, cambia o quita búsquedas cuando quieras: el siguiente barrido usa las nuevas. Todas comparten los prospectos de tu tarifa.'
            : 'Dinos qué tipo de negocio y en qué zona, y empezamos a buscarte prospectos. Puedes añadir varias combinaciones.'}
        </p>
      </div>

      <details className="rounded-xl border border-kairikos-border p-3" data-testid="prospecting-brief">
        <summary className="cursor-pointer text-sm font-medium">
          ¿No sabes a quién buscar? Cuéntanos de tu negocio
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-kairikos-muted">
            Con esto te proponemos rubros y zonas concretos. Tú decides cuáles usar: no cambiamos nada sin que lo
            guardes.
          </p>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">Tu web (opcional)</span>
            <input
              type="text"
              className="input w-full"
              placeholder="tunegocio.com"
              value={clientWebsite}
              onChange={(e) => setClientWebsite(e.target.value)}
              data-testid="prospecting-brief-website"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">¿Qué vendes?</span>
            <textarea
              className="input min-h-16 w-full"
              placeholder="p. ej. reformas de baños y cocinas para comunidades"
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              data-testid="prospecting-brief-description"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">¿Quién es tu mejor cliente?</span>
            <textarea
              className="input min-h-16 w-full"
              placeholder="p. ej. administradores de fincas con varios edificios"
              value={idealCustomer}
              onChange={(e) => setIdealCustomer(e.target.value)}
              data-testid="prospecting-brief-ideal"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">¿A quién no quieres? (opcional)</span>
            <textarea
              className="input min-h-16 w-full"
              placeholder="p. ej. obra nueva, o particulares"
              value={exclusions}
              onChange={(e) => setExclusions(e.target.value)}
              data-testid="prospecting-brief-exclusions"
            />
          </label>
          <button
            type="button"
            className="btn-ghost"
            onClick={suggest}
            disabled={suggesting}
            data-testid="prospecting-brief-suggest"
          >
            {suggesting ? 'Pensando…' : 'Proponme a quién buscar'}
          </button>

          {suggestNote ? (
            <p className="text-xs text-kairikos-muted" data-testid="prospecting-brief-note">
              {suggestNote}
            </p>
          ) : null}

          {suggestion ? (
            <div className="space-y-2" data-testid="prospecting-brief-suggestion">
              {suggestion.businessSummary ? (
                <p className="text-xs italic text-kairikos-muted">
                  Lo que hemos entendido: {suggestion.businessSummary}
                </p>
              ) : null}
              {suggestion.categories.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-kairikos-muted">Rubros:</span>
                  {suggestion.categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => applySuggestion('category', item)}
                      data-testid="prospecting-brief-category-option"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
              {suggestion.locations.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-kairikos-muted">Zonas:</span>
                  {suggestion.locations.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => applySuggestion('locationQuery', item)}
                      data-testid="prospecting-brief-location-option"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-kairikos-muted">
                Pulsa uno para ponerlo abajo: va al primer hueco libre o a una búsqueda nueva. Revísalo y guarda.
              </p>
            </div>
          ) : null}
        </div>
      </details>

      <div className="space-y-3" data-testid="prospecting-searches">
        {searches.map((row, index) => (
          <div
            key={index}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-kairikos-border p-3 sm:rounded-none sm:border-0 sm:p-0"
            data-testid="prospecting-search-row"
          >
            <label className="flex min-w-0 basis-full flex-col gap-1 text-sm sm:flex-1 sm:basis-0">
              <span className="text-xs font-medium text-kairikos-muted">Rubro</span>
              <input
                type="text"
                className="input w-full"
                placeholder="p. ej. administradores de fincas"
                value={row.category}
                onChange={(e) => updateRow(index, 'category', e.target.value)}
                data-testid="prospecting-search-category"
              />
            </label>
            <label className="flex min-w-0 basis-full flex-col gap-1 text-sm sm:flex-1 sm:basis-0">
              <span className="text-xs font-medium text-kairikos-muted">Zona</span>
              <input
                type="text"
                className="input w-full"
                placeholder="p. ej. Las Palmas de Gran Canaria"
                value={row.locationQuery}
                onChange={(e) => updateRow(index, 'locationQuery', e.target.value)}
                data-testid="prospecting-search-location"
              />
            </label>
            {searches.length > 1 || row.category || row.locationQuery ? (
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => removeRow(index)}
                aria-label={`Quitar la búsqueda ${index + 1}`}
                data-testid="prospecting-search-remove"
              >
                Quitar
              </button>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setSearches((rows) => [...rows, { ...EMPTY_ROW }])}
            disabled={searches.length >= MAX_BUSQUEDAS}
            data-testid="prospecting-search-add"
          >
            + Añadir búsqueda
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={saving}
            data-testid="prospecting-profile-save"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          {searches.length >= MAX_BUSQUEDAS ? (
            <span className="text-xs text-kairikos-muted">Hasta {MAX_BUSQUEDAS} búsquedas a la vez.</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="prospecting-profile-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="prospecting-profile-saved">
          Guardado.
        </p>
      ) : null}

      {configured ? (
        <div className="space-y-4 border-t border-kairikos-border pt-4" data-testid="prospecting-consent-section">
          <div className="space-y-2">
            <label className="block space-y-1 text-sm">
              <span className="text-xs font-medium text-kairikos-muted">
                ¿A qué te dedicas? Completa la frase «Nos dedicamos a…»
              </span>
              <input
                type="text"
                className="input w-full"
                placeholder="p. ej. reformas de baños y cocinas para comunidades"
                value={presentacion}
                onChange={(e) => setPresentacion(e.target.value)}
                data-testid="prospecting-presentacion"
              />
            </label>
            <p
              className={`text-xs ${presentacionLarga ? 'text-kairikos-danger' : 'text-kairikos-muted'}`}
              data-testid="prospecting-presentacion-count"
            >
              {presentacionLista?.length ?? 0} / {PRESENTACION_MAX}
              {presentacionLarga ? ' — acórtala: va dentro de una frase que se lee en el móvil.' : ''}
            </p>

            {mensajes.length > 0 ? (
              <div className="space-y-2" data-testid="prospecting-message-preview">
                <p className="text-xs font-medium text-kairikos-muted">
                  Esto es lo que recibiría, por ejemplo, «{PROSPECTO_DE_EJEMPLO}»:
                </p>
                {mensajes.map((m) => (
                  <div key={m.cuando} className="space-y-1">
                    <p className="text-xs text-kairikos-muted">{m.cuando}</p>
                    <p
                      className="rounded-xl border border-kairikos-border bg-kairikos-surface p-3 text-sm"
                      data-testid="prospecting-message-preview-item"
                    >
                      {m.texto}
                    </p>
                  </div>
                ))}
                <p className="text-xs text-kairikos-muted">
                  El nombre del prospecto cambia en cada mensaje; lo demás sale tal cual. En cuanto contesta, no le
                  escribimos más: la conversación es tuya.
                </p>
              </div>
            ) : (
              <p className="text-xs text-kairikos-muted" data-testid="prospecting-message-preview-empty">
                Escribe a qué te dedicas y aquí verás el mensaje exacto que enviaríamos en tu nombre.
              </p>
            )}

            {consentGiven && presentacionSinGuardar ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={save}
                disabled={saving || presentacionLarga || !presentacionLista}
                data-testid="prospecting-presentacion-save"
              >
                {saving ? 'Guardando…' : 'Guardar el mensaje nuevo'}
              </button>
            ) : null}
          </div>

          {autoPaused ? (
            <div className="space-y-2">
              <p className="text-sm text-kairikos-danger" data-testid="prospecting-auto-paused-banner">
                El contacto automático se pausó porque la calidad de tu número de WhatsApp bajó. Revísalo antes de
                reanudar.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={() => toggleConsent(true)}
                disabled={consentBusy || saving || !presentacionLista || presentacionLarga}
                data-testid="prospecting-consent-resume"
              >
                {consentBusy ? 'Reanudando…' : 'Reanudar contacto automático'}
              </button>
            </div>
          ) : consentGiven ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm" data-testid="prospecting-consent-active">
                Contacto automático por WhatsApp: activo.
              </p>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => toggleConsent(false)}
                disabled={consentBusy}
                data-testid="prospecting-consent-revoke"
              >
                {consentBusy ? 'Desactivando…' : 'Desactivar'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Este texto es lo que se autoriza. Si cambia, sube
                  PROSPECTING_CONSENT_VERSION (prospecting-contact.ts): el
                  permiso dado con un texto no vale para otro. */}
              <p className="text-sm text-kairikos-muted" data-testid="prospecting-consent-copy">
                Con tu autorización, escribimos por WhatsApp, desde tu propio número y con tu nombre, a cada prospecto
                nuevo: los mensajes de arriba, como mucho tres, y hasta {MAX_POR_DIA} al día en total. Eres responsable
                de este contacto.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={() => toggleConsent(true)}
                disabled={consentBusy || saving || !presentacionLista || presentacionLarga}
                data-testid="prospecting-consent-give"
              >
                {consentBusy ? 'Activando…' : 'Autorizar contacto automático'}
              </button>
            </div>
          )}
          {consentError ? (
            <p className="mt-2 text-sm text-kairikos-danger" data-testid="prospecting-consent-error">
              {consentError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
