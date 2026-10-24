'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StepSchemaKey } from '@/lib/wizard-schemas';
import { stepSchemas } from '@/lib/wizard-schemas';
import { getStep, getCommon } from '@/messages/wizard-es';
import { formatZodErrors, type FieldError } from './useZodValidation';
import { Button } from './primitives';

export interface WizardFormState {
  values: Record<StepSchemaKey, Record<string, unknown> | null>;
  setStepValue: <K extends StepSchemaKey>(step: K, value: Record<string, unknown>) => void;
  validateAll: () => { ok: boolean; firstError?: FieldError };
  errors: FieldError[];
  setErrors: (errs: FieldError[]) => void;
}

const FormContext = createContext<WizardFormState | null>(null);

export function useWizardForm(): WizardFormState {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error('useWizardForm must be used inside <WizardFormProvider>');
  return ctx;
}

export function WizardFormProvider({
  stepNumber,
  initialValues,
  onSubmit,
  isSubmitting,
  isSubmitted,
  isApproved = false,
  children,
}: {
  stepNumber: StepSchemaKey;
  initialValues: Record<StepSchemaKey, Record<string, unknown> | null>;
  onSubmit: (status: 'draft' | 'submitted', payload: Record<string, unknown>) => Promise<void> | void;
  isSubmitting: boolean;
  isSubmitted: boolean;
  isApproved?: boolean;
  children: ReactNode;
}) {
  const common = getCommon();
  const [values, setValues] = useState<Record<StepSchemaKey, Record<string, unknown> | null>>(initialValues);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const setStepValue = useCallback<WizardFormState['setStepValue']>((step, value) => {
    setValues((prev) => ({ ...prev, [step]: value }));
  }, []);

  const validateAll = useCallback((): { ok: boolean; firstError?: FieldError } => {
    const schema = stepSchemas[stepNumber];
    const data = values[stepNumber];
    if (!data) {
      return { ok: false, firstError: { path: '', message: common.required } };
    }
    const result = schema.safeParse(data);
    if (result.success) {
      setErrors([]);
      return { ok: true };
    }
    const fe = formatZodErrors(result.error);
    setErrors(fe);
    return { ok: false, firstError: fe[0] };
  }, [stepNumber, values, common.required]);

  useEffect(() => {
    setErrors([]);
  }, [stepNumber]);

  const ctx = useMemo<WizardFormState>(
    () => ({ values, setStepValue, validateAll, errors, setErrors }),
    [values, setStepValue, validateAll, errors],
  );

  // Reads the LIVE `values[stepNumber]` at click time — not a snapshot
  // frozen at the initial server-rendered payload. StepForm used to derive
  // the submit payload from `initialValues` (the props-seeded value from
  // the last server render), which never reflects what the client typed
  // into the form: for a first-time step that's `{}` (most steps default
  // to an empty catalog payload), so every "first save" silently
  // persisted an empty object instead of the client's actual answers.
  const handleSubmitClick = useCallback(
    (status: 'draft' | 'submitted') => {
      if (status === 'submitted') {
        const r = validateAll();
        if (!r.ok) return;
      }
      const cur = values[stepNumber];
      if (!cur) return;
      void onSubmit(status, cur);
    },
    [validateAll, values, stepNumber, onSubmit],
  );

  return (
    <FormContext.Provider value={ctx}>
      {children}
      <FormFooter
        stepNumber={stepNumber}
        onSubmit={handleSubmitClick}
        isSubmitting={isSubmitting}
        isSubmitted={isSubmitted}
        isApproved={isApproved}
        firstError={errors[0]}
      />
    </FormContext.Provider>
  );
}

function FormFooter({
  stepNumber,
  onSubmit,
  isSubmitting,
  isSubmitted,
  isApproved = false,
  firstError,
}: {
  stepNumber: StepSchemaKey;
  onSubmit: (status: 'draft' | 'submitted') => void;
  isSubmitting: boolean;
  isSubmitted: boolean;
  isApproved?: boolean;
  firstError?: FieldError;
}) {
  const step = getStep(stepNumber);
  return (
    <div className="space-y-2">
      {firstError ? (
        <p role="alert" className="text-xs text-kairikos-danger">
          {step.title}: {firstError.message}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 border-t border-kairikos-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {/* 24/10/2026 — un paso enviado se podía editar pero no reenviar:
              los campos seguían abiertos, el autoguardado está apagado y no
              había botón, así que lo corregido se perdía al salir sin aviso
              (pasó con el paso 3 del propio chatbot de Kairikos). La API
              siempre aceptó una versión nueva encima de una enviada o
              aprobada (wizard-client.ts); el bloqueo era solo de esta
              pantalla. Ahora se reenvía, y se revisa —y aprueba— la última. */}
          {isSubmitted ? (
            <>
              <span className="pill-success">{isApproved ? 'Aprobado' : 'En revisión por el operador'}</span>
              <Button
                variant="primary"
                onClick={() => onSubmit('submitted')}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Enviando…' : 'Enviar los cambios para revisión'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => onSubmit('submitted')}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Enviando…' : 'Enviar para revisión'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => onSubmit('draft')}
                disabled={isSubmitting}
              >
                Guardar borrador
              </Button>
            </>
          )}
        </div>
        <p className="text-xs text-kairikos-muted">
          {isApproved
            ? 'El bot usa esta versión. Si cambias algo, vuelve a enviarlo: hasta que se apruebe, el bot sigue con esta.'
            : isSubmitted
              ? 'El operador revisará este paso en un plazo de 24h hábiles. Si corriges algo, vuelve a enviarlo: se revisa la última versión.'
              : 'Puedes guardar un borrador y continuar después.'}
        </p>
      </div>
    </div>
  );
}
