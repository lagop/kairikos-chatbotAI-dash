'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboarding } from '@/lib/onboarding/self-serve-context';

const SECTORS = [
  { value: 'clinica', label: 'Clínica' },
  { value: 'restaurante', label: 'Restaurante / Bar' },
  { value: 'despacho', label: 'Despacho / Asesoría' },
  { value: 'peluqueria', label: 'Peluquería / Estética' },
  { value: 'inmobiliaria', label: 'Inmobiliaria' },
  { value: 'otro', label: 'Otro' },
] as const;

export function OnboardingConfig() {
  const router = useRouter();
  const { state, saveConfig, setStep, completeStep } = useOnboarding();
  const [businessName, setBusinessName] = useState(state.config.businessName ?? '');
  const [sector, setSector] = useState(state.config.sector ?? '');
  const [whatsapp, setWhatsapp] = useState(state.config.whatsapp ?? '');
  const [contactEmail, setContactEmail] = useState(state.config.contactEmail ?? state.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStep('config');
    if (!state.email) router.replace('/onboarding/signup');
    else if (!state.productTier) router.replace('/onboarding/product');
  }, [setStep, state.email, state.productTier, router]);

  const isValid = businessName.trim().length > 1 && sector.length > 0;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await saveConfig({
        businessName: businessName.trim(),
        sector,
        whatsapp: whatsapp.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
      });
      completeStep('config');
      router.push('/onboarding/pago');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'config_failed');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-5" noValidate>
      <header className="space-y-1">
        <h2 id="wizard-heading-config" className="text-xl font-semibold">
          Configuración mínima
        </h2>
        <p className="text-sm text-kairikos-muted">
          Solo lo imprescindible para abrir tu portal. El resto lo ajustas después.
        </p>
      </header>

      <label className="grid gap-1">
        <span className="label">Nombre del negocio</span>
        <input
          data-testid="config-business"
          required
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          className="input"
          autoComplete="organization"
          placeholder="Clínica Dental Sonríe"
        />
      </label>

      <label className="grid gap-1">
        <span className="label">Sector</span>
        <select
          data-testid="config-sector"
          required
          value={sector}
          onChange={(e) => setSector(e.target.value)}
          className="input"
        >
          <option value="" disabled>
            Selecciona un sector
          </option>
          {SECTORS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className="label">WhatsApp (opcional)</span>
          <input
            data-testid="config-whatsapp"
            type="tel"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            className="input"
            autoComplete="tel"
            placeholder="+34 600 000 000"
          />
        </label>
        <label className="grid gap-1">
          <span className="label">Email de contacto</span>
          <input
            data-testid="config-contact-email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            className="input"
            autoComplete="email"
          />
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-kairikos-danger/40 bg-kairikos-danger/10 px-3 py-2 text-sm text-kairikos-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => router.push('/onboarding/product')}
        >
          Atrás
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={!isValid || submitting}
          data-testid="config-submit"
        >
          {submitting ? 'Guardando…' : 'Continuar al pago'}
        </button>
      </div>
    </form>
  );
}
