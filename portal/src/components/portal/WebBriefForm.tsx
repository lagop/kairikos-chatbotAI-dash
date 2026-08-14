'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  GOAL_OPTIONS,
  GOAL_LABELS,
  CONTENT_PROVIDED_BY_OPTIONS,
  CONTENT_PROVIDED_BY_LABELS,
  PAGE_OPTIONS,
  INTEGRATION_OPTIONS,
} from '@/lib/web-brief-schema';

// =============================================================================
// Standalone form for the 'web' product's brief — see
// prisma/schema.prisma's WebBrief model comment for why this doesn't reuse
// the chatbot wizard's per-step form machinery (StepForm.tsx). One form,
// one POST to /api/portal/web-brief, two actions: save a draft (anything
// goes) or submit (businessName/goal/pagesNeeded required — enforced
// server-side; this form doesn't duplicate that validation, it just
// surfaces the server's error).
// =============================================================================

export interface WebBriefFormValues {
  businessName: string;
  vertical: string;
  goal: string;
  targetAudience: string;
  hasExistingBrand: boolean | null;
  brandAssetsNote: string;
  pagesNeeded: string[];
  otherPagesNote: string;
  contentProvidedBy: string;
  desiredDomain: string;
  referenceWebsites: string;
  integrationsNeeded: string[];
  otherIntegrationsNote: string;
  additionalNotes: string;
}

const EMPTY_VALUES: WebBriefFormValues = {
  businessName: '',
  vertical: '',
  goal: '',
  targetAudience: '',
  hasExistingBrand: null,
  brandAssetsNote: '',
  pagesNeeded: [],
  otherPagesNote: '',
  contentProvidedBy: '',
  desiredDomain: '',
  referenceWebsites: '',
  integrationsNeeded: [],
  otherIntegrationsNote: '',
  additionalNotes: '',
};

function CheckboxGroup({
  legend,
  options,
  selected,
  onToggle,
  testIdPrefix,
}: {
  legend: string;
  options: readonly string[];
  selected: string[];
  onToggle: (option: string) => void;
  testIdPrefix: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="label">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
              className={[
                'cursor-pointer rounded-full border px-3 py-1.5 text-sm transition',
                checked
                  ? 'border-kairikos-accent/40 bg-kairikos-accent/15 text-kairikos-accent'
                  : 'border-kairikos-border bg-kairikos-surface2 text-kairikos-muted hover:text-kairikos-text',
              ].join(' ')}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() => onToggle(opt)}
                data-testid={`${testIdPrefix}-${opt}`}
              />
              {opt}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function WebBriefForm({ initial }: { initial: Partial<WebBriefFormValues> | null }) {
  const router = useRouter();
  const [values, setValues] = useState<WebBriefFormValues>({ ...EMPTY_VALUES, ...initial });
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedDraftAt, setSavedDraftAt] = useState<number | null>(null);

  function set<K extends keyof WebBriefFormValues>(key: K, value: WebBriefFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function toggle(key: 'pagesNeeded' | 'integrationsNeeded', option: string) {
    setValues((v) => ({
      ...v,
      [key]: v[key].includes(option) ? v[key].filter((x) => x !== option) : [...v[key], option],
    }));
  }

  async function save(submit: boolean) {
    setBusy(submit ? 'submit' : 'draft');
    setError(null);
    try {
      const res = await fetch('/api/portal/web-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: values.businessName,
          vertical: values.vertical || undefined,
          goal: values.goal || undefined,
          targetAudience: values.targetAudience || undefined,
          hasExistingBrand: values.hasExistingBrand ?? undefined,
          brandAssetsNote: values.brandAssetsNote || undefined,
          pagesNeeded: values.pagesNeeded,
          otherPagesNote: values.otherPagesNote || undefined,
          contentProvidedBy: values.contentProvidedBy || undefined,
          desiredDomain: values.desiredDomain || undefined,
          referenceWebsites: values.referenceWebsites || undefined,
          integrationsNeeded: values.integrationsNeeded,
          otherIntegrationsNote: values.otherIntegrationsNote || undefined,
          additionalNotes: values.additionalNotes || undefined,
          submit,
        }),
      });
      if (!res.ok) {
        setError(
          submit
            ? 'Revisa los campos obligatorios: nombre del negocio, objetivo y al menos una página.'
            : 'No se pudo guardar el borrador. Inténtalo de nuevo.',
        );
        setBusy(null);
        return;
      }
      if (submit) {
        router.refresh();
        return;
      }
      setSavedDraftAt(Date.now());
      setBusy(null);
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(null);
    }
  }

  return (
    <form
      className="card space-y-5"
      data-testid="web-brief-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">Cuéntanos sobre tu web</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Con esto arrancamos el diseño. Podés completarlo de a poco — lo que dejes en blanco lo coordinamos por
          soporte más adelante.
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger" role="alert">
          {error}
        </div>
      ) : null}
      {savedDraftAt ? (
        <div className="rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success" role="status">
          Borrador guardado.
        </div>
      ) : null}

      <div className="space-y-1">
        <label htmlFor="web-brief-business-name" className="label">Nombre del negocio *</label>
        <input
          id="web-brief-business-name"
          className="input"
          value={values.businessName}
          onChange={(e) => set('businessName', e.target.value)}
          maxLength={160}
          data-testid="web-brief-business-name"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-vertical" className="label">Sector / rubro</label>
        <input
          id="web-brief-vertical"
          className="input"
          value={values.vertical}
          onChange={(e) => set('vertical', e.target.value)}
          placeholder="Peluquería, gestoría, clínica dental…"
          maxLength={80}
          data-testid="web-brief-vertical"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-goal" className="label">Objetivo principal del sitio *</label>
        <select
          id="web-brief-goal"
          className="input"
          value={values.goal}
          onChange={(e) => set('goal', e.target.value)}
          data-testid="web-brief-goal"
        >
          <option value="">— Elegí una opción —</option>
          {GOAL_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{GOAL_LABELS[opt]}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-audience" className="label">¿A quién le hablás? (público objetivo)</label>
        <textarea
          id="web-brief-audience"
          className="input min-h-[80px]"
          value={values.targetAudience}
          onChange={(e) => set('targetAudience', e.target.value)}
          maxLength={500}
          data-testid="web-brief-audience"
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="label">¿Ya tenés marca definida (logo, colores)?</legend>
        <div className="flex gap-2">
          {[
            { label: 'Sí', value: true },
            { label: 'No', value: false },
          ].map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => set('hasExistingBrand', opt.value)}
              className={
                values.hasExistingBrand === opt.value
                  ? 'rounded-full border border-kairikos-accent/40 bg-kairikos-accent/15 px-3 py-1.5 text-sm text-kairikos-accent'
                  : 'rounded-full border border-kairikos-border bg-kairikos-surface2 px-3 py-1.5 text-sm text-kairikos-muted hover:text-kairikos-text'
              }
              data-testid={`web-brief-has-brand-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="web-brief-brand-note" className="label">Enlaces a tu logo/marca (si tenés) o notas</label>
        <textarea
          id="web-brief-brand-note"
          className="input min-h-[80px]"
          value={values.brandAssetsNote}
          onChange={(e) => set('brandAssetsNote', e.target.value)}
          maxLength={1000}
          data-testid="web-brief-brand-note"
        />
      </div>

      <CheckboxGroup
        legend="Páginas que necesitás *"
        options={PAGE_OPTIONS}
        selected={values.pagesNeeded}
        onToggle={(opt) => toggle('pagesNeeded', opt)}
        testIdPrefix="web-brief-page"
      />

      <div className="space-y-1">
        <label htmlFor="web-brief-other-pages" className="label">Otras páginas (si marcaste &quot;Otro&quot;)</label>
        <input
          id="web-brief-other-pages"
          className="input"
          value={values.otherPagesNote}
          onChange={(e) => set('otherPagesNote', e.target.value)}
          maxLength={300}
          data-testid="web-brief-other-pages"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-content-by" className="label">¿Quién escribe los textos del sitio?</label>
        <select
          id="web-brief-content-by"
          className="input"
          value={values.contentProvidedBy}
          onChange={(e) => set('contentProvidedBy', e.target.value)}
          data-testid="web-brief-content-by"
        >
          <option value="">— Elegí una opción —</option>
          {CONTENT_PROVIDED_BY_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{CONTENT_PROVIDED_BY_LABELS[opt]}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-domain" className="label">Dominio deseado (si ya tenés uno, o el que te gustaría)</label>
        <input
          id="web-brief-domain"
          className="input"
          value={values.desiredDomain}
          onChange={(e) => set('desiredDomain', e.target.value)}
          placeholder="minegocio.com"
          maxLength={200}
          data-testid="web-brief-domain"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-references" className="label">Sitios de referencia — URLs y qué te gusta de cada uno</label>
        <textarea
          id="web-brief-references"
          className="input min-h-[100px]"
          value={values.referenceWebsites}
          onChange={(e) => set('referenceWebsites', e.target.value)}
          maxLength={1500}
          data-testid="web-brief-references"
        />
      </div>

      <CheckboxGroup
        legend="Integraciones que necesitás"
        options={INTEGRATION_OPTIONS}
        selected={values.integrationsNeeded}
        onToggle={(opt) => toggle('integrationsNeeded', opt)}
        testIdPrefix="web-brief-integration"
      />

      <div className="space-y-1">
        <label htmlFor="web-brief-other-integrations" className="label">Otras integraciones (si marcaste &quot;Otro&quot;)</label>
        <input
          id="web-brief-other-integrations"
          className="input"
          value={values.otherIntegrationsNote}
          onChange={(e) => set('otherIntegrationsNote', e.target.value)}
          maxLength={300}
          data-testid="web-brief-other-integrations"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="web-brief-notes" className="label">Notas adicionales</label>
        <textarea
          id="web-brief-notes"
          className="input min-h-[100px]"
          value={values.additionalNotes}
          onChange={(e) => set('additionalNotes', e.target.value)}
          maxLength={2000}
          data-testid="web-brief-notes"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={busy !== null}
          onClick={() => void save(false)}
          data-testid="web-brief-save-draft"
        >
          {busy === 'draft' ? 'Guardando…' : 'Guardar borrador'}
        </button>
        <button type="submit" className="btn-primary" disabled={busy !== null} data-testid="web-brief-submit">
          {busy === 'submit' ? 'Enviando…' : 'Enviar brief'}
        </button>
      </div>
    </form>
  );
}
