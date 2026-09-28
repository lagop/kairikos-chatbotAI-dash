'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_CONTACTOS_POR_DIA as MAX_POR_DIA,
  normalizarPresentacion,
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
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
  not_found: 'Guarda tu perfil de búsqueda antes de activar el contacto automático.',
  presentacion_demasiado_larga: `A qué te dedicas tiene que caber en ${PRESENTACION_MAX} caracteres.`,
  falta_presentacion: 'Escribe a qué te dedicas antes de autorizar: sin eso el primer mensaje no se puede enviar.',
};

export interface ProspectingProfile {
  category: string | null;
  locationQuery: string | null;
  radiusMeters: number | null;
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
  const [category, setCategory] = useState(profile?.category ?? '');
  const [locationQuery, setLocationQuery] = useState(profile?.locationQuery ?? '');
  const [radiusKm, setRadiusKm] = useState(Math.round((profile?.radiusMeters ?? 10000) / 1000));
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

  const configured = Boolean(profile?.category && profile?.locationQuery);

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
          texto: rellenarPlantilla(s.texto, [PROSPECTO_DE_EJEMPLO, businessName]),
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
    if (!category.trim() || !locationQuery.trim()) {
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
          category: category.trim(),
          locationQuery: locationQuery.trim(),
          clientWebsite: clientWebsite.trim(),
          businessDescription: businessDescription.trim(),
          idealCustomer: idealCustomer.trim(),
          exclusions: exclusions.trim(),
          presentacion: presentacion.trim(),
          radiusMeters: Math.min(Math.max(radiusKm, 1), 50) * 1000,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return false;
      }
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
            ? 'Cambia el rubro o la zona cuando quieras — el siguiente barrido usará el perfil nuevo.'
            : 'Dinos qué tipo de negocio y en qué zona, y empezamos a buscarte prospectos.'}
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
                      onClick={() => setCategory(item)}
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
                      onClick={() => setLocationQuery(item)}
                      data-testid="prospecting-brief-location-option"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="text-xs text-kairikos-muted">
                Pulsa uno para ponerlo abajo, revísalo y guarda. Puedes cambiarlo cuando quieras.
              </p>
            </div>
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Rubro</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. peluquerías"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            data-testid="prospecting-profile-category"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Zona</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. Las Palmas de Gran Canaria"
            value={locationQuery}
            onChange={(e) => setLocationQuery(e.target.value)}
            data-testid="prospecting-profile-location"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Radio (km)</span>
          <input
            type="number"
            min={1}
            max={50}
            className="input w-20"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value) || 1)}
            data-testid="prospecting-profile-radius"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={save}
          disabled={saving}
          data-testid="prospecting-profile-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
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
