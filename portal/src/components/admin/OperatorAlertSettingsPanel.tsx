'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStepUpFetch } from '@/components/portal/useStepUpFetch';

// =============================================================================
// /admin/portal/settings/alerts — destinatarios de las alertas de operador.
// Ver lib/operator-alert-settings.ts. Mismo patrón que SeoSettingsPanel:
// valor inicial desde el servidor, guardar, router.refresh().
//
// Enseña DE DÓNDE sale el valor que se está usando. Es la mitad útil de la
// pantalla: el fallo que la motivó fue precisamente que nadie podía ver que
// la lista estaba vacía.
// =============================================================================

type Source = 'portal' | 'env' | 'none';

export interface OperatorAlertSettingsInitial {
  operatorEmails: string[];
  operatorSource: Source;
  ceoEmail: string | null;
  ceoSource: Source;
  updatedAt: string | null;
  updatedBy: string | null;
}

const SOURCE_LABEL: Record<Source, string> = {
  portal: 'Guardado aquí',
  env: 'Desde la variable de entorno del servidor',
  none: 'Sin configurar — no se envía nada',
};

const SOURCE_PILL: Record<Source, string> = {
  portal: 'pill-success',
  env: 'pill-warning',
  none: 'pill-danger',
};

const ERROR_LABEL: Record<string, string> = {
  invalid_email: 'Hay direcciones que no parecen correos válidos',
  no_operator_emails: 'Pon al menos un correo para las alertas.',
  too_many_emails: 'Como mucho 10 correos.',
  invalid_body: 'Revisa los campos.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  service_unavailable: 'No disponible en este momento.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function OperatorAlertSettingsPanel({ initial }: { initial: OperatorAlertSettingsInitial }) {
  const router = useRouter();
  const { stepUpFetch, stepUpModal } = useStepUpFetch();
  const [operatorEmails, setOperatorEmails] = useState(initial.operatorEmails.join('\n'));
  const [ceoEmail, setCeoEmail] = useState(initial.ceoEmail ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const res = await stepUpFetch('/api/admin/portal/settings/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorEmails, ceoEmail }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        const code = body.error as string | undefined;
        const invalid = Array.isArray(body.invalid) ? (body.invalid as string[]) : [];
        const label = (code && ERROR_LABEL[code]) || 'No se pudo guardar.';
        setError(invalid.length > 0 ? `${label}: ${invalid.join(', ')}` : label);
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
    <section className="card space-y-5" aria-label="Destinatarios de las alertas" data-testid="alert-settings-card">
      {stepUpModal}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="alert-operator-emails" className="font-semibold">
            Correos que reciben las alertas
          </label>
          <span className={SOURCE_PILL[initial.operatorSource]} data-testid="alert-operator-source">
            {SOURCE_LABEL[initial.operatorSource]}
          </span>
        </div>
        <p className="text-xs text-kairikos-muted">
          Uno por línea. Reciben todas las alertas: altas atascadas, WhatsApp de un negocio caído, tokens a punto de
          caducar, consumo anómalo y peticiones de ayuda de los clientes.
        </p>
        <textarea
          id="alert-operator-emails"
          className="input min-h-24 w-full font-mono text-sm"
          value={operatorEmails}
          onChange={(e) => setOperatorEmails(e.target.value)}
          placeholder="equipo@tuempresa.com"
          data-testid="alert-operator-emails"
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="alert-ceo-email" className="font-semibold">
            Correo para escaladas
          </label>
          <span className={SOURCE_PILL[initial.ceoSource]} data-testid="alert-ceo-source">
            {SOURCE_LABEL[initial.ceoSource]}
          </span>
        </div>
        <p className="text-xs text-kairikos-muted">
          Solo recibe las revisiones de configuración que llevan demasiado tiempo sin atender. Puede ser uno de los de
          arriba.
        </p>
        <input
          id="alert-ceo-email"
          type="email"
          className="input w-full"
          value={ceoEmail}
          onChange={(e) => setCeoEmail(e.target.value)}
          placeholder="direccion@tuempresa.com"
          data-testid="alert-ceo-email"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={saving} onClick={save} data-testid="alert-settings-save">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        {initial.updatedAt ? (
          <span className="text-xs text-kairikos-muted">
            Última modificación: {DATE_FORMAT.format(new Date(initial.updatedAt))}
            {initial.updatedBy ? ` · ${initial.updatedBy}` : ''}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="alert-settings-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="alert-settings-saved">
          Guardado. Las próximas alertas ya van a estos correos.
        </p>
      ) : null}
    </section>
  );
}
