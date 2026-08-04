export type WizardStep =
  | 'signup'
  | 'product'
  | 'config'
  | 'pago'
  | 'activado';

export const WIZARD_STEPS: readonly WizardStep[] = [
  'signup',
  'product',
  'config',
  'pago',
  'activado',
] as const;

export function isWizardStep(value: string): value is WizardStep {
  return (WIZARD_STEPS as readonly string[]).includes(value);
}