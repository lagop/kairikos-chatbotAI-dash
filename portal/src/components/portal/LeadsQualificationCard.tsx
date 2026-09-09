'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// "Sistema IA de captación" — the client's own qualification profile: what
// a good lead looks like for them. Deliberately self-serve, same shape as
// ProspectingProfileCard.tsx (its neighbor on this same page): controlled
// inputs, one PATCH, router.refresh() on success. Feeds
// lib/lead-classification-ai.ts's classifier directly — see
// LeadQualificationProfile's schema comment for why this is NOT the
// chatbot wizard engine.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa los datos — el perfil de cliente ideal es obligatorio, y el email debe ser válido.',
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

export interface LeadQualificationProfile {
  perfilClienteIdeal: string | null;
  senalesDescarte: string | null;
  emailAviso: string | null;
}

/** Fase 4 — lo que el cliente ya nos contó en otro producto. Se usa solo
 *  como valor inicial de un campo vacío: en cuanto guarda, manda lo suyo. */
export interface PrefilledField {
  field: string;
  value: string;
  sourceLabel: string;
}

export function LeadsQualificationCard({
  profile,
  prefill = [],
}: {
  profile: LeadQualificationProfile | null;
  prefill?: PrefilledField[];
}) {
  const suggested = Object.fromEntries(prefill.map((p) => [p.field, p]));
  const router = useRouter();
  const [perfilClienteIdeal, setPerfilClienteIdeal] = useState(profile?.perfilClienteIdeal ?? '');
  const [senalesDescarte, setSenalesDescarte] = useState(profile?.senalesDescarte ?? '');
  const [emailAviso, setEmailAviso] = useState(profile?.emailAviso ?? suggested.emailAviso?.value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const configured = Boolean(profile?.perfilClienteIdeal);

  async function save() {
    setError(null);
    setSaved(false);
    if (!perfilClienteIdeal.trim()) {
      setError(ERROR_LABEL.invalid_body);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/portal/leads/qualification', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          perfilClienteIdeal: perfilClienteIdeal.trim(),
          senalesDescarte: senalesDescarte.trim(),
          emailAviso: emailAviso.trim(),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Criterios de cualificación" data-testid="leads-qualification-card">
      <div>
        <p className="text-sm font-semibold">¿Qué es un lead bueno para ti?</p>
        <p className="text-xs text-kairikos-muted">
          {configured
            ? 'Cambia esto cuando quieras — la IA lo usa para puntuar tus próximos contactos.'
            : 'Cuéntanos a quién le interesa comprarte, y la IA priorizará tus contactos según esto en vez de adivinar.'}
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-kairikos-muted">Perfil de cliente ideal</span>
        <textarea
          className="input"
          rows={3}
          placeholder="p. ej. dueños de locales que quieren reformar antes de abrir, con presupuesto ya decidido"
          value={perfilClienteIdeal}
          onChange={(e) => setPerfilClienteIdeal(e.target.value)}
          data-testid="leads-qualification-perfil"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-kairikos-muted">Qué descarta a un contacto (opcional)</span>
        <textarea
          className="input"
          rows={2}
          placeholder="p. ej. solo pide precio sin decir ciudad, o busca empleo"
          value={senalesDescarte}
          onChange={(e) => setSenalesDescarte(e.target.value)}
          data-testid="leads-qualification-descarte"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-kairikos-muted">Email de aviso (opcional)</span>
        <input
          type="email"
          className="input"
          placeholder="ventas@tunegocio.com — si lo dejas vacío, usamos el email de tu cuenta"
          value={emailAviso}
          onChange={(e) => setEmailAviso(e.target.value)}
          data-testid="leads-qualification-email"
        />
      </label>

      <button
        type="button"
        className="btn-primary"
        onClick={save}
        disabled={saving}
        data-testid="leads-qualification-save"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="leads-qualification-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="leads-qualification-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
