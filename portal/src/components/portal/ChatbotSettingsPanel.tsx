'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ChatbotMessageCaps } from '@/lib/chatbot-settings';

// =============================================================================
// /admin/portal/settings/chatbot — el tope de mensajes al mes por tarifa.
//
// Misma forma que SeoSettingsPanel: el valor actual se lee en el servidor,
// se guarda desde aquí y se refresca. El coste aproximado se calcula a la
// vista para que el número no sea abstracto: quien lo cambia está decidiendo
// cuánto puede llegar a costar un cliente al mes.
// =============================================================================

/** Coste aproximado por mensaje contestado, en euros. Ver la cabecera de
 *  lib/chatbot-settings.ts para de dónde sale. Es una estimación para
 *  orientar al operador, no una factura. */
const COST_PER_MESSAGE_EUR = 0.005;

const TIERS: ReadonlyArray<{ key: keyof ChatbotMessageCaps; label: string; priceEur: number }> = [
  { key: 'starter', label: 'Starter', priceEur: 99 },
  { key: 'pro', label: 'Pro', priceEur: 249 },
  { key: 'premium', label: 'Premium', priceEur: 499 },
];

const MIN = 100;
const MAX = 500000;

const ERROR_LABEL: Record<string, string> = {
  invalid_body: `Cada tope debe ser un entero entre ${MIN} y ${MAX}.`,
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  service_unavailable: 'No disponible en este momento.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo guardar.';
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function ChatbotSettingsPanel({ initialCaps }: { initialCaps: ChatbotMessageCaps }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({
    starter: String(initialCaps.starter),
    pro: String(initialCaps.pro),
    premium: String(initialCaps.premium),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = TIERS.map((t) => ({ ...t, value: Number(values[t.key]) }));
  const isValid = parsed.every((t) => Number.isInteger(t.value) && t.value >= MIN && t.value <= MAX);

  async function save() {
    setError(null);
    setSaved(false);
    if (!isValid) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/portal/settings/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          starter: Number(values.starter),
          pro: Number(values.pro),
          premium: Number(values.premium),
        }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setError(errorLabel(body.error as string | undefined));
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
    <section className="card space-y-4" aria-label="Tope de mensajes del chatbot" data-testid="chatbot-settings-card">
      <div>
        <p className="font-semibold">Mensajes que contesta el bot al mes</p>
        <p className="mt-1 text-xs text-kairikos-muted">
          Por cada chatbot contratado, no por cliente: quien tiene dos chatbots paga dos tarifas y tiene dos topes.
          Al alcanzarlo, el bot deja de responder hasta el mes siguiente; lo que escriba la persona se sigue
          guardando. Cuenta respuestas del bot, que es lo que cuesta dinero.
        </p>
      </div>

      <ul className="space-y-3" data-testid="chatbot-settings-list">
        {parsed.map((tier) => {
          const cost = Number.isFinite(tier.value) ? tier.value * COST_PER_MESSAGE_EUR : null;
          const ok = Number.isInteger(tier.value) && tier.value >= MIN && tier.value <= MAX;
          return (
            <li key={tier.key} className="flex flex-wrap items-center gap-3">
              <span className="w-24 text-sm font-medium">{tier.label}</span>
              <input
                type="number"
                min={MIN}
                max={MAX}
                step={100}
                className="input w-32"
                value={values[tier.key]}
                onChange={(e) => setValues((v) => ({ ...v, [tier.key]: e.target.value }))}
                data-testid={`chatbot-settings-cap-${tier.key}`}
                aria-label={`Tope mensual de la tarifa ${tier.label}`}
              />
              <span className="text-xs text-kairikos-muted">
                {ok && cost !== null ? (
                  <>
                    ≈ {cost.toFixed(0)} € de IA en el peor mes, sobre {tier.priceEur} € de tarifa
                  </>
                ) : (
                  <span className="text-kairikos-danger">
                    Entero entre {MIN} y {MAX}.
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="btn-primary"
        disabled={!isValid || saving}
        onClick={save}
        data-testid="chatbot-settings-save"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="chatbot-settings-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="chatbot-settings-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
