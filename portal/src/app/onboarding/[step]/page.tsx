import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper';
import { OnboardingSignup } from '@/components/onboarding/steps/OnboardingSignup';
import { OnboardingProduct } from '@/components/onboarding/steps/OnboardingProduct';
import { OnboardingConfig } from '@/components/onboarding/steps/OnboardingConfig';
import { OnboardingPago } from '@/components/onboarding/steps/OnboardingPago';
import { OnboardingActivado } from '@/components/onboarding/steps/OnboardingActivado';
import { WIZARD_STEPS, isWizardStep, type WizardStep } from '@/lib/onboarding/wizard-steps';

interface PageProps {
  params: { step: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const step = params.step as WizardStep;
  const titleMap: Record<WizardStep, string> = {
    signup: 'Registro — Wizard Kairikos',
    product: 'Elige tu producto — Kairikos',
    config: 'Configuración mínima — Kairikos',
    pago: 'Pago — Kairikos',
    activado: 'Activación completa — Kairikos',
  };
  const descriptionMap: Record<WizardStep, string> = {
    signup: 'Crea tu cuenta para empezar.',
    product: 'Selecciona el plan que mejor se ajusta a tu negocio.',
    config: 'Datos mínimos para empezar a trabajar con Kairikos.',
    pago: 'Paga con Stripe de forma segura para activar tu portal.',
    activado: 'Tu portal Kairikos ya está listo.',
  };
  if (!WIZARD_STEPS.includes(step)) return {};
  return {
    title: titleMap[step],
    description: descriptionMap[step],
    robots: { index: false, follow: false },
  };
}

function resolveStep(step: string): WizardStep {
  return (WIZARD_STEPS as readonly string[]).includes(step) ? (step as WizardStep) : 'signup';
}

export default function WizardStepPage({ params }: PageProps) {
  const step = resolveStep(params.step);
  if (!WIZARD_STEPS.includes(step)) notFound();
  return (
    <div className="grid gap-6">
      <OnboardingStepper current={step} />
      <section className="card" aria-labelledby={`wizard-heading-${step}`}>
        {step === 'signup' ? <OnboardingSignup /> : null}
        {step === 'product' ? <OnboardingProduct /> : null}
        {step === 'config' ? <OnboardingConfig /> : null}
        {step === 'pago' ? <OnboardingPago /> : null}
        {step === 'activado' ? <OnboardingActivado /> : null}
      </section>
    </div>
  );
}
