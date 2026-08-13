import type { ChatbotTier } from '@/types/portal';

export type FunnelVertical = 'abogado' | 'clinica' | 'inmobiliaria' | 'gestoria' | 'otro';
export type FunnelTimeWindow = '7d' | '30d' | '90d' | 'all';

export const VERTICAL_LABEL: Record<FunnelVertical, string> = {
  abogado: 'Abogados',
  clinica: 'Clínicas',
  inmobiliaria: 'Inmobiliarias',
  gestoria: 'Gestorías',
  otro: 'Otros',
};

export const STEP_LABELS: Record<string, string> = {
  '1': 'Perfil del negocio',
  '2': 'Personalidad y límites',
  '3': 'Servicios y tarifas',
  '4': 'FAQ',
  '5': 'Horario',
  '6': 'Captación de leads',
  '7': 'Derivación',
  '8': 'Canales',
  '9': 'Mensajes',
  '10': 'Cumplimiento',
  '11': 'Pruebas',
};

export interface WizardFunnelStep {
  stepKey: string;
  stepLabel: string;
  reached: number;
  abandoned: number;
  completionRate: number;
}

export interface WizardFunnelData {
  totalStarted: number;
  totalInProgress: number;
  totalCompleted: number;
  totalAbandoned: number;
  overallCompletionRate: number;
  steps: WizardFunnelStep[];
  byVertical: Record<FunnelVertical, { started: number; completed: number; abandoned: number }>;
  byTier: Record<ChatbotTier, { started: number; completed: number; abandoned: number }>;
}

export interface WizardFunnelParams {
  vertical: FunnelVertical | 'all';
  tier: ChatbotTier | 'all';
  timeWindow: FunnelTimeWindow;
}

const ALL_STEPS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];

const VERTICAL_SPLIT: Record<FunnelVertical, number> = {
  abogado: 0.25,
  clinica: 0.2,
  inmobiliaria: 0.3,
  gestoria: 0.15,
  otro: 0.1,
};

const TIER_SPLIT: Record<ChatbotTier, number> = {
  starter: 0.4,
  pro: 0.45,
  premium: 0.15,
};

function applyFilterFactor(
  base: number,
  vertical: FunnelVertical | 'all',
  tier: ChatbotTier | 'all',
): number {
  let factor = 1;
  if (vertical !== 'all') factor *= VERTICAL_SPLIT[vertical];
  if (tier !== 'all') factor *= TIER_SPLIT[tier];
  return Math.max(Math.round(base * factor), vertical !== 'all' || tier !== 'all' ? Math.max(Math.round(base * factor), 1) : base);
}

function buildFunnelData(params: WizardFunnelParams): WizardFunnelData {
  const multiplier =
    params.timeWindow === '7d' ? 0.25 : params.timeWindow === '30d' ? 1 : params.timeWindow === '90d' ? 2.5 : 4;

  const n = Math.round(28 * multiplier);
  const baseStarted = Math.max(n, 1);
  const started = applyFilterFactor(baseStarted, params.vertical, params.tier);

  const stepDropRates: Record<string, number> = {
    '1': 0.02,
    '2': 0.03,
    '3': 0.12,
    '4': 0.04,
    '5': 0.03,
    '6': 0.06,
    '7': 0.08,
    '8': 0.03,
    '9': 0.02,
    '10': 0.05,
    '11': 0.01,
  };

  const steps: WizardFunnelStep[] = [];
  let remaining = started;

  for (const key of ALL_STEPS) {
    const abortRate = stepDropRates[key] ?? 0.05;
    const abandoned = Math.max(Math.round(remaining * abortRate), 0);
    const reached = remaining;
    remaining = Math.max(remaining - abandoned, 0);
    const next = key === '11' ? 0 : Math.max(Math.round(remaining * (1 - (stepDropRates[String(Number(key) + 1)] ?? 0.05))), 0);

    steps.push({
      stepKey: key,
      stepLabel: STEP_LABELS[key] ?? `Paso ${key}`,
      reached,
      abandoned,
      completionRate: reached > 0 ? Math.round(((reached - abandoned) / reached) * 100) : 0,
    });
  }

  const totalCompleted = remaining;
  const totalAbandoned = started - totalCompleted;
  const totalInProgress = Math.round(totalAbandoned * 0.15);
  const adjustedAbandoned = totalAbandoned - totalInProgress;

  const byVertical = {} as Record<FunnelVertical, { started: number; completed: number; abandoned: number }>;
  for (const [v, pct] of Object.entries(VERTICAL_SPLIT)) {
    const vStarted = Math.round(started * pct);
    const vCompleted = Math.round(totalCompleted * pct);
    byVertical[v as FunnelVertical] = {
      started: vStarted,
      completed: vCompleted,
      abandoned: Math.max(vStarted - vCompleted, 0),
    };
  }

  const byTier = {} as Record<ChatbotTier, { started: number; completed: number; abandoned: number }>;
  for (const [t, pct] of Object.entries(TIER_SPLIT)) {
    const tStarted = Math.round(started * pct);
    const tCompleted = Math.round(totalCompleted * pct);
    byTier[t as ChatbotTier] = {
      started: tStarted,
      completed: tCompleted,
      abandoned: Math.max(tStarted - tCompleted, 0),
    };
  }

  return {
    totalStarted: started,
    totalInProgress,
    totalCompleted,
    totalAbandoned: adjustedAbandoned,
    overallCompletionRate: started > 0 ? Math.round((totalCompleted / started) * 100) : 0,
    steps,
    byVertical,
    byTier,
  };
}

const FUNNEL_CACHE = new Map<string, WizardFunnelData>();

export function getWizardFunnelData(params: WizardFunnelParams): WizardFunnelData {
  const cacheKey = `${params.timeWindow}|${params.vertical}|${params.tier}`;
  if (!FUNNEL_CACHE.has(cacheKey)) {
    FUNNEL_CACHE.set(cacheKey, buildFunnelData(params));
  }
  return FUNNEL_CACHE.get(cacheKey)!;
}

export const TIME_WINDOW_OPTIONS: { value: FunnelTimeWindow; label: string }[] = [
  { value: '7d', label: '7 días' },
  { value: '30d', label: '30 días' },
  { value: '90d', label: '90 días' },
  { value: 'all', label: 'Todo' },
];

export const VERTICAL_OPTIONS: { value: FunnelVertical | 'all'; label: string }[] = [
  { value: 'all', label: 'Todas las verticales' },
  { value: 'abogado', label: 'Abogados' },
  { value: 'clinica', label: 'Clínicas' },
  { value: 'inmobiliaria', label: 'Inmobiliarias' },
  { value: 'gestoria', label: 'Gestorías' },
  { value: 'otro', label: 'Otros' },
];

export const TIER_OPTIONS: { value: ChatbotTier | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos los planes' },
  { value: 'starter', label: 'Web Starter' },
  { value: 'pro', label: 'Web Pro' },
  { value: 'premium', label: 'Web Premium' },
];
