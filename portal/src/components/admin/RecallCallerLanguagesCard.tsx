'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CALLER_LANGUAGES, CALLER_LANGUAGE_LABEL, type CallerLanguage } from '@/lib/recall-caller-language';

// =============================================================================
// 15/11/2026 — en qué idiomas se escribe a quien llama a este cliente.
// Ver src/lib/recall-caller-language.ts y la ruta
// /api/admin/portal/recall/[subscriptionId]/languages.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_language: 'Ese idioma no existe.',
  not_found: 'No se encontró la suscripción.',
  invalid_body: 'Petición incorrecta.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor.',
};

export function RecallCallerLanguagesCard({
  subscriptionId,
  initial,
}: {
  subscriptionId: string;
  initial: CallerLanguage[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<CallerLanguage>>(() => new Set<CallerLanguage>(['es', ...initial]));
  const [saved, setSaved] = useState<string>(() => [...new Set<CallerLanguage>(['es', ...initial])].sort().join(','));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const current = [...selected].sort().join(',');
  const dirty = current !== saved;

  function toggle(lang: CallerLanguage) {
    if (lang === 'es') return;
    setMessage(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lang)) next.delete(lang);
      else next.add(lang);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/portal/recall/${subscriptionId}/languages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerLanguages: CALLER_LANGUAGES.filter((l) => selected.has(l)) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; changed?: boolean };
      if (!res.ok) {
        setMessage({ kind: 'error', text: ERROR_LABEL[body.error ?? ''] ?? 'No se pudo guardar.' });
        return;
      }
      setSaved(current);
      setMessage({
        kind: 'ok',
        text: body.changed
          ? 'Guardado. Las plantillas de los idiomas nuevos se mandan a Meta en el próximo ciclo (unos 5 minutos); hasta que las apruebe, se sigue escribiendo en español.'
          : 'Sin cambios.',
      });
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-kairikos-border p-4" data-testid="recall-caller-languages">
      <h3 className="text-sm font-semibold">Idiomas para quien llama</h3>
      <p className="mt-1 text-sm text-kairikos-muted">
        El primer WhatsApp (o SMS) sale en el idioma que sugiere el prefijo del número: alemán para +49, +43 y +41;
        inglés para +44, +1, Irlanda, los países nórdicos y los Países Bajos. Si ese idioma no está activo, en español.
      </p>
      <fieldset className="mt-3 flex flex-wrap gap-4">
        <legend className="sr-only">Idiomas activos</legend>
        {CALLER_LANGUAGES.map((lang) => (
          <label key={lang} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.has(lang)}
              disabled={lang === 'es' || busy}
              onChange={() => toggle(lang)}
              data-testid={`recall-caller-language-${lang}`}
            />
            {CALLER_LANGUAGE_LABEL[lang]}
            {lang === 'es' ? <span className="text-xs text-kairikos-muted">(siempre)</span> : null}
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void save()}
          disabled={!dirty || busy}
          data-testid="recall-caller-languages-save"
        >
          {busy ? 'Guardando…' : 'Guardar idiomas'}
        </button>
        {message ? (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.kind === 'error' ? 'text-kairikos-danger' : 'text-kairikos-success'}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
