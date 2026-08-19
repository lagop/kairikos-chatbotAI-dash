'use client';

import { useState, useTransition, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { WizardBlockProgress, type WizardBlockProgressStep } from '@/components/portal/WizardBlockProgress';
import { StepForm, type WizardSavedState } from '@/components/portal/wizard-steps/StepForm';
import { getProductCatalog } from '@/lib/catalogs';

type ToastKind = 'success' | 'error' | 'info';
type AutosaveStatus = 'idle' | 'saving' | 'saved';

interface WizardStepShellProps {
  productCode: string;
  stepNumber: number;
  stepKey: string;
  stepLabel: string;
  block: string;
  visibleForTier: boolean;
  autoConfigured: boolean;
  v11Deferred: boolean;
  effectivePayload: Record<string, unknown> | null;
  savedPayload: Record<string, unknown> | null;
  saved: WizardSavedState;
  isDatabaseConfigured: boolean;
  steps: WizardBlockProgressStep[];
  /** WP-29 — fields on this step whose value was pre-filled from another
   *  contracted product's wizard, keyed by which product it came from.
   *  Empty (the default) when nothing was inherited — either because
   *  there's no correspondence for this step yet, or because the client
   *  already has their own saved data here. */
  inheritedFrom?: { field: string; fromProductCode: string }[];
}

const AUTOSAVE_DEBOUNCE_MS = 800;

export function WizardStepShell(props: WizardStepShellProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSaving, setIsSaving] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>('idle');
  const [toast, setToast] = useState<{ kind: ToastKind; message: string } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const {
    productCode,
    stepNumber,
    stepKey,
    stepLabel,
    steps,
    visibleForTier,
    isDatabaseConfigured,
  } = props;

  const visibleSteps = steps.filter((s) => s.visible && !s.v11Deferred);
  const currentIdx = visibleSteps.findIndex((s) => s.key === stepKey);
  const prevStep = currentIdx > 0 ? visibleSteps[currentIdx - 1] : null;
  const nextStep = currentIdx < visibleSteps.length - 1 ? visibleSteps[currentIdx + 1] : null;

  const stepSaved = props.saved;
  const isSubmitted = stepSaved.status === 'submitted' || stepSaved.status === 'approved';
  const inheritedSourceLabels = Array.from(
    new Set((props.inheritedFrom ?? []).map((f) => getProductCatalog(f.fromProductCode).label)),
  );
  const [latestPayload, setLatestPayload] = useState<Record<string, unknown> | null>(
    props.savedPayload ?? props.effectivePayload ?? null,
  );

  const showToast = useCallback((kind: ToastKind, message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 4500);
  }, []);

  const performSave = useCallback(
    async (status: 'draft' | 'submitted', payload: Record<string, unknown>) => {
      if (!isMountedRef.current) return;
      setIsSaving(true);
      if (status === 'draft') setAutosaveStatus('saving');
      try {
        const res = await fetch(`/api/portal/wizard/${productCode}/${stepKey}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: payload, status }),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { detail?: string };
          showToast('error', `Error al guardar: ${err.detail ?? res.statusText}`);
          if (status === 'draft') setAutosaveStatus('idle');
          return;
        }

        if (status === 'draft') {
          setAutosaveStatus('saved');
          setTimeout(() => {
            if (isMountedRef.current) setAutosaveStatus('idle');
          }, 2000);
        } else {
          showToast(
            'success',
            'Paso enviado para revisión del operador. Recibirás notificación cuando esté aprobado.',
          );
        }

        startTransition(() => {
          router.refresh();
        });
      } catch (err) {
        showToast('error', `Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
        if (status === 'draft') setAutosaveStatus('idle');
      } finally {
        setIsSaving(false);
      }
    },
    [productCode, stepKey, showToast, router],
  );

  const handleFormChange = useCallback(
    (payload: Record<string, unknown>) => {
      setLatestPayload(payload);
      if (!isDatabaseConfigured || isSubmitted) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        performSave('draft', payload);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [isDatabaseConfigured, isSubmitted, performSave],
  );

  useEffect(() => {
    // Reacts to React 18 StrictMode's dev-only mount→cleanup→mount cycle
    // (next.config.js has reactStrictMode: true). Without resetting to
    // true here, the cleanup from that first synthetic unmount leaves
    // isMountedRef permanently false for the rest of the component's real
    // lifetime — every performSave() call after that silently no-ops on
    // its `if (!isMountedRef.current) return` guard, in every dev session.
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleSave = async (status: 'draft' | 'submitted') => {
    if (!isDatabaseConfigured) {
      showToast('info', 'El asistente está en modo de demostración. Los cambios no se guardan.');
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!latestPayload) {
      showToast('error', 'No hay datos para guardar todavía.');
      return;
    }
    await performSave(status, latestPayload);
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Configuración del chatbot"
        title={stepLabel}
        description={`Paso ${stepNumber} de ${visibleSteps.length}`}
        actions={
          visibleForTier && isDatabaseConfigured && !isSubmitted ? (
            <span
              aria-live="polite"
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                autosaveStatus === 'saving'
                  ? 'text-kairikos-accent'
                  : autosaveStatus === 'saved'
                    ? 'text-kairikos-success'
                    : 'text-kairikos-muted'
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  autosaveStatus === 'saving'
                    ? 'bg-kairikos-accent animate-pulse'
                    : autosaveStatus === 'saved'
                      ? 'bg-kairikos-success'
                      : 'bg-kairikos-muted/40'
                }`}
              />
              {autosaveStatus === 'saving'
                ? 'Guardando…'
                : autosaveStatus === 'saved'
                  ? 'Guardado'
                  : 'Autoguardado activo'}
            </span>
          ) : null
        }
      />

      <WizardBlockProgress steps={steps} currentStepNumber={stepNumber} />

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : toast.kind === 'error'
                ? 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
                : 'border-kairikos-accent/40 bg-kairikos-accent/10 text-kairikos-text'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {props.v11Deferred ? (
        <div className="card space-y-4">
          <div className="rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 p-6 text-center">
            <p className="text-lg font-semibold text-kairikos-accent">Próximamente</p>
            <p className="mt-2 text-sm text-kairikos-muted">
              El paso &quot;{props.stepLabel}&quot; estará disponible en una próxima versión. 
              Mientras tanto, el resto de la configuración del chatbot funciona con normalidad.
            </p>
          </div>
        </div>
      ) : visibleForTier ? (
        <div className="card space-y-6">
          {props.saved.seededFromIntake ? (
            <div className="rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 p-4 text-sm text-kairikos-accent2">
              <p className="font-semibold">Precargado desde tu formulario inicial</p>
              <p className="mt-1 text-kairikos-muted">
                Rellenamos este paso con lo que nos contaste al darte de alta. Revísalo y corrige lo que haga falta antes de continuar.
              </p>
            </div>
          ) : null}
          {inheritedSourceLabels.length > 0 ? (
            <div className="rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 p-4 text-sm text-kairikos-accent2">
              <p className="font-semibold">
                Heredado de {inheritedSourceLabels.join(', ')}
              </p>
              <p className="mt-1 text-kairikos-muted">
                Ya nos diste esta información al configurar otro producto. Revísala y corrige lo que haga falta antes de continuar — los cambios aquí no afectan a la configuración original.
              </p>
            </div>
          ) : null}
          <StepForm
            stepNumber={props.stepNumber}
            stepLabel={props.stepLabel}
            block={props.block}
            visibleForTier={props.visibleForTier}
            autoConfigured={props.autoConfigured}
            effectivePayload={props.effectivePayload}
            savedPayload={props.savedPayload}
            saved={props.saved}
            onChange={handleFormChange}
            onSubmit={async (status, payload) => {
              if (debounceRef.current) clearTimeout(debounceRef.current);
              await performSave(status, payload);
            }}
            isSubmitting={isSaving || isPending}
            step10Consentimiento={
              props.stepNumber === 6
                ? (props.savedPayload?.plantilla_base as string | undefined) ?? null
                : null
            }
          />
        </div>
      ) : (
        <div className="card space-y-4">
          <StepForm
            stepNumber={props.stepNumber}
            stepLabel={props.stepLabel}
            block={props.block}
            visibleForTier={props.visibleForTier}
            autoConfigured={props.autoConfigured}
            effectivePayload={props.effectivePayload}
            savedPayload={props.savedPayload}
            saved={props.saved}
          />
        </div>
      )}

      <nav
        aria-label="Navegación entre pasos"
        className="flex flex-col gap-3 sm:flex-row sm:justify-between"
      >
        {prevStep ? (
          <Link
            href={`/portal/wizard/${productCode}/${prevStep.key}`}
            className="btn-ghost w-full sm:w-auto"
          >
            ← {prevStep.label}
          </Link>
        ) : (
          <div />
        )}
        {nextStep ? (
          <Link
            href={`/portal/wizard/${productCode}/${nextStep.key}`}
            className="btn-primary w-full sm:w-auto"
          >
            {nextStep.label} →
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
