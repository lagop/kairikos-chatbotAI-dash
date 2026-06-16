import wizardEs from '@/messages/wizard-es.json';

export type WizardEsMessages = typeof wizardEs;

export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface FieldMessages {
  label: string;
  helper?: string;
  helperText?: string;
  placeholder?: string;
  options?: Record<string, string>;
  addLabel?: string;
  addService?: string;
  addQuestion?: string;
  addSchedule?: string;
  addRule?: string;
  addField?: string;
  addPrompt?: string;
  addTest?: string;
  addExample?: string;
  override?: string;
  note?: string;
  subfields: Record<string, FieldMessages>;
  disabled?: string;
  upload?: string;
  uploaded?: string;
}

export const emptyField: FieldMessages = { label: '', subfields: {} };

export interface StepMessages {
  title: string;
  subtitle: string;
  fields: Record<string, FieldMessages>;
  minOneChannel?: string;
  runTests?: string;
  testResults?: string;
  testPassed?: string;
  testFailed?: string;
  autoConfigured?: { text: string; description: string };
}

export interface ErrorMessages {
  required: string;
  email: string;
  url: string;
  minLength: (n: number) => string;
  maxLength: (n: number) => string;
  minItems: (n: number) => string;
  maxItems: (n: number) => string;
  invalidFormat: string;
  fileTooLarge: string;
  invalidFileType: string;
  numberMin: (n: number) => string;
  numberMax: (n: number) => string;
  invalidTime: string;
  invalidDate: string;
  pastDate: string;
  selectRequired: string;
  checkboxRequired: string;
  invalidPhone: string;
  invalidUrl: string;
  valueMismatch: string;
}

export interface CommonMessages {
  loading: string;
  error: string;
  required: string;
  optional: string;
  yes: string;
  no: string;
  selectOption: string;
  selectOptions: string;
  add: string;
  remove: string;
  edit: string;
  cancel: string;
  confirm: string;
  close: string;
  seeMore: string;
  seeLess: string;
}

export interface SlaMessages {
  banner: string;
  bannerTooltip: string;
}

export interface ProgressMessages {
  blockIdentity: string;
  blockBehavior: string;
  blockActivation: string;
  step: string;
  of: string;
  completed: string;
  autoConfigured: string;
}

export interface NavigationMessages {
  saveDraft: string;
  saveDraftSuccess: string;
  continue: string;
  back: string;
  next: string;
  submit: string;
  submitConfirm: string;
  submitSuccess: string;
}

const interp = (template: string, params: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));

export function getCommon(): CommonMessages {
  const c = (wizardEs as WizardEsMessages).wizard.common;
  return {
    loading: c.loading,
    error: c.error,
    required: c.required,
    optional: c.optional,
    yes: c.yes,
    no: c.no,
    selectOption: c.selectOption,
    selectOptions: c.selectOptions,
    add: c.add,
    remove: c.remove,
    edit: c.edit,
    cancel: c.cancel,
    confirm: c.confirm,
    close: c.close,
    seeMore: c.seeMore,
    seeLess: c.seeLess,
  };
}

export function getErrors(): ErrorMessages {
  const e = (wizardEs as WizardEsMessages).wizard.errors;
  return {
    required: e.required,
    email: e.email,
    url: e.url,
    minLength: (n) => interp(e.minLength, { min: n }),
    maxLength: (n) => interp(e.maxLength, { max: n }),
    minItems: (n) => interp(e.minItems, { min: n }),
    maxItems: (n) => interp(e.maxItems, { max: n }),
    invalidFormat: e.invalidFormat,
    fileTooLarge: e.fileTooLarge,
    invalidFileType: e.invalidFileType,
    numberMin: (n) => interp(e.numberMin, { min: n }),
    numberMax: (n) => interp(e.numberMax, { max: n }),
    invalidTime: e.invalidTime,
    invalidDate: e.invalidDate,
    pastDate: e.pastDate,
    selectRequired: e.selectRequired,
    checkboxRequired: e.checkboxRequired,
    invalidPhone: e.invalidPhone,
    invalidUrl: e.invalidUrl,
    valueMismatch: e.valueMismatch,
  };
}

export function getSla(): SlaMessages {
  return (wizardEs as WizardEsMessages).wizard.sla;
}

export function getProgress(): ProgressMessages {
  return (wizardEs as WizardEsMessages).wizard.progress;
}

export function getNavigation(): NavigationMessages {
  return (wizardEs as WizardEsMessages).wizard.navigation;
}

export function getStep(step: StepNumber): StepMessages {
  const key = String(step) as keyof WizardEsMessages['steps'];
  const raw = (wizardEs as WizardEsMessages).steps?.[key];
  if (!raw) {
    throw new Error(`No wizard messages for step ${step}`);
  }
  return normalizeStep(raw as unknown as StepMessages);
}

function normalizeField(f: FieldMessages): FieldMessages {
  return {
    ...f,
    subfields: f.subfields ?? {},
  };
}

function normalizeStep(s: StepMessages): StepMessages {
  const fields: Record<string, FieldMessages> = {};
  for (const [k, v] of Object.entries(s.fields ?? {})) {
    fields[k] = normalizeField(v);
  }
  return { ...s, fields };
}
