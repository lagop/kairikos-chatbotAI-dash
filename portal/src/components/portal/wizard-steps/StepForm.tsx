import { useEffect } from 'react';
import { getStep, getCommon } from '@/messages/wizard-es';
import { WizardFormProvider, useWizardForm, type WizardFormState } from './WizardFormProvider';
import { Step1Perfil } from './Step1Perfil';
import { Step2Personalidad } from './Step2Personalidad';
import { Step3Servicios } from './Step3Servicios';
import { Step4Faq } from './Step4Faq';
import { Step5Horario } from './Step5Horario';
import { Step6Captacion } from './Step6Captacion';
import { Step7Derivacion } from './Step7Derivacion';
import { Step8Canales } from './Step8Canales';
import { Step9Mensajes } from './Step9Mensajes';
import { Step10Cumplimiento } from './Step10Cumplimiento';
import { Step11Pruebas } from './Step11Pruebas';
import type { StepSchemaKey } from '@/lib/wizard-schemas';
import type { Step1Input } from '@/lib/wizard-schemas';
import type { Step2Input } from '@/lib/wizard-schemas';
import type { Step3Input } from '@/lib/wizard-schemas';
import type { Step4Input } from '@/lib/wizard-schemas';
import type { Step5Input } from '@/lib/wizard-schemas';
import type { Step6Input } from '@/lib/wizard-schemas';
import type { Step7Input } from '@/lib/wizard-schemas';
import type { Step8Input } from '@/lib/wizard-schemas';
import type { Step9Input } from '@/lib/wizard-schemas';
import type { Step10Input } from '@/lib/wizard-schemas';
import type { Step11Input } from '@/lib/wizard-schemas';

export type WizardSavedState = {
  hasSavedVersion: boolean;
  status?: string | undefined;
  submittedAt?: string | null;
  approvedAt?: string | null;
  activeForBot?: boolean | undefined;
  // WP-24 — true when the current version's row was written by the
  // intake-seeding job (actor: 'system'), not typed in by the client.
  seededFromIntake?: boolean;
};

export interface StepFormProps {
  stepNumber: number;
  stepLabel: string;
  block: string;
  visibleForTier: boolean;
  autoConfigured: boolean;
  effectivePayload: Record<string, unknown> | null;
  savedPayload: Record<string, unknown> | null;
  saved: WizardSavedState;
  /**
   * When provided, the form becomes a controlled container. It receives a
   * submitter (status) and the v0.2 spec payload for the current step. The
   * parent (`WizardStepShell`) is responsible for hitting
   * `/api/portal/wizard/[step]`.
   */
  onSubmit?: (status: 'draft' | 'submitted', payload: Record<string, unknown>) => Promise<void> | void;
  /**
   * Called whenever the current step's payload changes. Used by the shell to
   * debounce-autosave a draft PATCH.
   */
  onChange?: (payload: Record<string, unknown>) => void;
  isSubmitting?: boolean;
  step10Consentimiento?: string | null;
}

const BLOCK_LABELS: Record<string, string> = {
  identidad: 'Identidad del negocio',
  comportamiento: 'Comportamiento del chatbot',
  activacion: 'Activación y pruebas',
};

function StepHeading({
  stepNumber,
  stepLabel,
  blockLabel,
  description,
}: {
  stepNumber: number;
  stepLabel: string;
  blockLabel: string;
  description: string;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
        {blockLabel}
      </p>
      <h2 className="text-xl font-semibold sm:text-2xl">
        Paso {stepNumber}: {stepLabel}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-kairikos-muted">{description}</p>
    </div>
  );
}

function AutoConfiguredNotice({ stepNumber }: { stepNumber: number }) {
  const m = getStep(stepNumber as 3 | 7);
  if (!m.autoConfigured) return null;
  return (
    <div className="rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 p-4">
      <p className="text-sm font-semibold text-kairikos-accent2">{m.autoConfigured.text}</p>
      <p className="mt-1 text-sm text-kairikos-muted">{m.autoConfigured.description}</p>
    </div>
  );
}

function NoDBNotice() {
  return (
    <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 p-4 text-sm text-kairikos-muted">
      El asistente está en modo de demostración. Los cambios no se guardan.
    </div>
  );
}

export function StepForm(props: StepFormProps) {
  const {
    stepNumber,
    stepLabel,
    block,
    visibleForTier,
    autoConfigured,
  } = props;

  const common = getCommon();
  const blockLabel = BLOCK_LABELS[block] ?? block;
  const isSubmitted = props.saved?.status === 'submitted' || props.saved?.status === 'approved';

  if (!visibleForTier) {
    return (
      <div className="space-y-4">
        <StepHeading
          stepNumber={stepNumber}
          stepLabel={stepLabel}
          blockLabel={blockLabel}
          description="Este paso se configura automáticamente para tu plan."
        />
        <AutoConfiguredNotice stepNumber={stepNumber} />
      </div>
    );
  }

  const stepMsg = getStep(stepNumber as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11);

  const stepKey = stepNumber as StepSchemaKey;
  const seedValue = (props.savedPayload ?? props.effectivePayload ?? null) as Record<string, unknown> | null;
  const initialValues = { [stepKey]: seedValue } as Record<StepSchemaKey, Record<string, unknown> | null>;

  const handleSubmit = async (status: 'draft' | 'submitted') => {
    if (!props.onSubmit) return;
    const cur = initialValues[stepKey] ?? null;
    if (!cur) return;
    await props.onSubmit(status, cur);
  };

  return (
    <div className="space-y-6">
      <StepHeading
        stepNumber={stepNumber}
        stepLabel={stepLabel}
        blockLabel={blockLabel}
        description={stepMsg.subtitle}
      />
      {autoConfigured ? (
        <p className="rounded-xl border border-kairikos-accent/20 bg-kairikos-accent/5 px-4 py-2 text-sm text-kairikos-accent2">
          Aún no has guardado información en este paso. El chatbot usará valores predeterminados por ahora.
        </p>
      ) : null}
      {!props.onSubmit ? <NoDBNotice /> : null}
      <WizardFormProvider
        stepNumber={stepNumber as StepSchemaKey}
        initialValues={initialValues}
        onSubmit={handleSubmit}
        isSubmitting={!!props.isSubmitting}
        isSubmitted={isSubmitted}
      >
        <StepFields
          stepNumber={stepNumber}
          step10Consentimiento={props.step10Consentimiento ?? null}
          onChange={props.onChange}
        />
      </WizardFormProvider>
    </div>
  );
}

function StepFields({
  stepNumber,
  step10Consentimiento,
  onChange,
}: {
  stepNumber: number;
  step10Consentimiento: string | null;
  onChange?: (payload: Record<string, unknown>) => void;
}) {
  const form = useWizardForm();
  const vertical = ((form.values[1] as Step1Input | null)?.vertical ?? null) as string | null;
  const nombreComercial = ((form.values[1] as Step1Input | null)?.nombre_comercial ?? null) as string | null;
  const step10Value = (form.values[10] as Step10Input | null) ?? null;
  const step10Consent = step10Value?.plantilla_base ?? step10Consentimiento ?? null;

  useEffect(() => {
    const cur = form.values[stepNumber as StepSchemaKey];
    if (cur && onChange) onChange(cur);
  }, [form.values, stepNumber, onChange]);

  switch (stepNumber) {
    case 1:
      return <Step1Perfil value={form.values[1] as Step1Input | null} onChange={(v) => form.setStepValue(1, v as unknown as Record<string, unknown>)} />;
    case 2:
      return <Step2Personalidad value={form.values[2] as Step2Input | null} vertical={vertical} onChange={(v) => form.setStepValue(2, v as unknown as Record<string, unknown>)} />;
    case 3:
      return <Step3Servicios value={form.values[3] as Step3Input | null} vertical={vertical} onChange={(v) => form.setStepValue(3, v as unknown as Record<string, unknown>)} />;
    case 4:
      return <Step4Faq value={form.values[4] as Step4Input | null} onChange={(v) => form.setStepValue(4, v as unknown as Record<string, unknown>)} />;
    case 5:
      return <Step5Horario value={form.values[5] as Step5Input | null} onChange={(v) => form.setStepValue(5, v as unknown as Record<string, unknown>)} />;
    case 6:
      return <Step6Captacion value={form.values[6] as Step6Input | null} vertical={vertical} step10Consentimiento={step10Consent} onChange={(v) => form.setStepValue(6, v as unknown as Record<string, unknown>)} />;
    case 7:
      return <Step7Derivacion value={form.values[7] as Step7Input | null} onChange={(v) => form.setStepValue(7, v as unknown as Record<string, unknown>)} />;
    case 8:
      return <Step8Canales value={form.values[8] as Step8Input | null} onChange={(v) => form.setStepValue(8, v as unknown as Record<string, unknown>)} />;
    case 9:
      return <Step9Mensajes value={form.values[9] as Step9Input | null} nombreComercial={nombreComercial} onChange={(v) => form.setStepValue(9, v as unknown as Record<string, unknown>)} />;
    case 10:
      return <Step10Cumplimiento value={form.values[10] as Step10Input | null} vertical={vertical} onChange={(v) => form.setStepValue(10, v as unknown as Record<string, unknown>)} />;
    case 11:
      return <Step11Pruebas value={form.values[11] as Step11Input | null} onChange={(v) => form.setStepValue(11, v as unknown as Record<string, unknown>)} />;
    default:
      return <p className="text-sm text-kairikos-muted">Formulario no disponible para este paso.</p>;
  }
}
