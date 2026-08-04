'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';

// =============================================================================
// KAIA-4263 — Self-serve wizard session state (product-agnostic onboarding).
//
// Held in a single React context so the multi-step UI can share data
// without a backend round-trip on every navigation. Persisted to
// localStorage so a refresh, browser crash, or Stripe redirect-back
// does not lose the session — and so the funnel analytics can re-emit
// the last step on re-entry.
//
// Funnel events (`step_seen`, `step_completed`) are emitted to
// `/api/portal/track` via the beacon helper. This is a *tracker*; the
// backend analyst view lives at /admin/portal/onboarding-funnel.
// =============================================================================

// Re-export the step list / type from a non-`'use client'` module so server
// components (e.g. `/onboarding/[step]/page.tsx`) can call
// `WIZARD_STEPS.includes(step)` without triggering Next.js 14's
// "called a client function from the server" proxy error.
export type { WizardStep } from './wizard-steps';
export { WIZARD_STEPS } from './wizard-steps';

export interface OnboardingState {
  sessionId: string;
  email: string | null;
  passwordSet: boolean;
  tenantSlug: string | null;
  productTier: 'starter' | 'pro' | 'premium' | null;
  productId: string | null;
  clientProductId: string | null;
  config: {
    businessName: string | null;
    sector: string | null;
    whatsapp: string | null;
    contactEmail: string | null;
  };
  checkoutUrl: string | null;
  active: boolean;
  activatedAt: string | null;
  abandonedReason: string | null;
  currentStep: WizardStep;
  stepSeenAt: Partial<Record<WizardStep, string>>;
  stepCompletedAt: Partial<Record<WizardStep, string>>;
}

interface SignupPayload {
  email: string;
  passwordSet?: boolean;
}

interface ProductPayload {
  productId: string;
  productTier: OnboardingState['productTier'];
}

interface ConfigPayload {
  businessName: string;
  sector: string;
  whatsapp?: string;
  contactEmail?: string;
}

interface CheckoutPayload {
  checkoutUrl: string;
  clientProductId: string;
}

interface ActivationPayload {
  active: boolean;
  activatedAt?: string | null;
}

interface AbortedPayload {
  reason: string;
}

type Action =
  | { type: 'HYDRATE'; payload: Partial<OnboardingState> }
  | { type: 'SET_STEP'; payload: WizardStep }
  | { type: 'COMPLETE_STEP'; payload: WizardStep }
  | { type: 'SIGNUP'; payload: SignupPayload }
  | { type: 'PRODUCT'; payload: ProductPayload }
  | { type: 'CONFIG'; payload: ConfigPayload }
  | { type: 'CHECKOUT'; payload: CheckoutPayload }
  | { type: 'ACTIVATE'; payload: ActivationPayload }
  | { type: 'ABORT'; payload: AbortedPayload }
  | { type: 'TENANT_SLUG'; payload: string }
  | { type: 'RESET' };

const STORAGE_KEY = 'kairikos.onboarding.v1';

function now(): string {
  return new Date().toISOString();
}

function ensureSessionId(existing: string | undefined): string {
  if (existing && existing.length >= 12) return existing;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `onb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function nextStepAfter(step: WizardStep): WizardStep {
  const idx = WIZARD_STEPS.indexOf(step);
  if (idx < 0 || idx >= WIZARD_STEPS.length - 1) return step;
  return WIZARD_STEPS[idx + 1] as WizardStep;
}

function reducer(state: OnboardingState, action: Action): OnboardingState {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload };
    case 'SET_STEP': {
      const ts = now();
      return {
        ...state,
        currentStep: action.payload,
        stepSeenAt: { ...state.stepSeenAt, [action.payload]: ts },
      };
    }
    case 'COMPLETE_STEP': {
      const ts = now();
      const completed = { ...state.stepCompletedAt, [action.payload]: ts };
      return {
        ...state,
        stepCompletedAt: completed,
        currentStep: nextStepAfter(action.payload),
      };
    }
    case 'SIGNUP':
      return {
        ...state,
        email: action.payload.email,
        passwordSet: action.payload.passwordSet ?? true,
        currentStep: 'product',
      };
    case 'PRODUCT':
      return {
        ...state,
        productId: action.payload.productId,
        productTier: action.payload.productTier,
        currentStep: 'config',
      };
    case 'CONFIG':
      return {
        ...state,
        config: {
          ...state.config,
          businessName: action.payload.businessName,
          sector: action.payload.sector,
          whatsapp: action.payload.whatsapp ?? state.config.whatsapp,
          contactEmail: action.payload.contactEmail ?? state.config.contactEmail,
        },
        currentStep: 'pago',
      };
    case 'CHECKOUT':
      return {
        ...state,
        checkoutUrl: action.payload.checkoutUrl,
        clientProductId: action.payload.clientProductId,
      };
    case 'ACTIVATE':
      return {
        ...state,
        active: action.payload.active,
        activatedAt: action.payload.activatedAt ?? now(),
        currentStep: 'activado',
      };
    case 'ABORT':
      return { ...state, abandonedReason: action.payload.reason, active: false };
    case 'TENANT_SLUG':
      return { ...state, tenantSlug: action.payload };
    case 'RESET':
      return { ...state, abandonedReason: 'reset', active: false };
    default:
      return state;
  }
}

const DEFAULT_STATE: OnboardingState = {
  sessionId: '',
  email: null,
  passwordSet: false,
  tenantSlug: null,
  productId: null,
  productTier: null,
  clientProductId: null,
  config: { businessName: null, sector: null, whatsapp: null, contactEmail: null },
  checkoutUrl: null,
  active: false,
  activatedAt: null,
  abandonedReason: null,
  currentStep: 'signup',
  stepSeenAt: {},
  stepCompletedAt: {},
};

interface OnboardingContextValue {
  state: OnboardingState;
  setStep(step: WizardStep): void;
  completeStep(step: WizardStep): void;
  signup(payload: SignupPayload): Promise<void>;
  selectProduct(payload: ProductPayload): Promise<void>;
  saveConfig(payload: ConfigPayload): Promise<void>;
  startCheckout(): Promise<string | null>;
  activate(payload: ActivationPayload): Promise<void>;
  abort(payload: AbortedPayload): Promise<void>;
  reset(): void;
  hasReachedStep(step: WizardStep): boolean;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function safeStorageRead(): Partial<OnboardingState> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<OnboardingState>;
  } catch {
    return null;
  }
}

function safeStorageWrite(state: OnboardingState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors — analytics still record
  }
}

interface TrackEvent {
  type: 'onboarding_event';
  event: 'step_seen' | 'step_completed' | 'signup' | 'product_selected' | 'config_saved' | 'checkout_started' | 'activated' | 'abandoned';
  step?: WizardStep;
  reason?: string;
  sessionId: string;
  ts: string;
  path: string;
}

function trackOnboarding(event: Omit<TrackEvent, 'type' | 'path'>): void {
  if (typeof window === 'undefined') return;
  const body = JSON.stringify({
    type: 'onboarding_event',
    event: event.event,
    step: event.step,
    reason: event.reason,
    sessionId: event.sessionId,
    ts: event.ts,
    path: window.location.pathname,
  });
  try {
    if ('sendBeacon' in navigator) {
      const ok = navigator.sendBeacon('/api/portal/track', body);
      if (ok) return;
    }
  } catch {
    // fall through to fetch
  }
  void fetch('/api/portal/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  });
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, DEFAULT_STATE);

  useEffect(() => {
    const persisted = safeStorageRead();
    const sessionId = ensureSessionId(persisted?.sessionId);
    dispatch({
      type: 'HYDRATE',
      payload: {
        ...(persisted ?? {}),
        sessionId,
        stepSeenAt: persisted?.stepSeenAt ?? {},
        stepCompletedAt: persisted?.stepCompletedAt ?? {},
        config: persisted?.config ?? DEFAULT_STATE.config,
      },
    });
  }, []);

  useEffect(() => {
    safeStorageWrite(state);
  }, [state]);

  const setStep = useCallback((step: WizardStep) => {
    dispatch({ type: 'SET_STEP', payload: step });
    trackOnboarding({
      event: 'step_seen',
      step,
      sessionId: state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const completeStep = useCallback((step: WizardStep) => {
    dispatch({ type: 'COMPLETE_STEP', payload: step });
    trackOnboarding({
      event: 'step_completed',
      step,
      sessionId: state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const signup = useCallback(async (payload: SignupPayload) => {
    const res = await fetch('/api/onboarding/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: payload.email, source: 'self_serve_landing' }),
    });
    const data = (await res.json().catch(() => ({}))) as { sessionId?: string; tenantSlug?: string; error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? `signup_failed_${res.status}`);
    }
    if (data.sessionId) dispatch({ type: 'HYDRATE', payload: { sessionId: data.sessionId } });
    if (data.tenantSlug) dispatch({ type: 'TENANT_SLUG', payload: data.tenantSlug });
    dispatch({ type: 'SIGNUP', payload });
    trackOnboarding({
      event: 'signup',
      sessionId: data.sessionId ?? state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const selectProduct = useCallback(async (payload: ProductPayload) => {
    dispatch({ type: 'PRODUCT', payload });
    trackOnboarding({
      event: 'product_selected',
      step: 'product',
      sessionId: state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const saveConfig = useCallback(async (payload: ConfigPayload) => {
    const res = await fetch('/api/onboarding/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, ...payload }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `config_failed_${res.status}`);
    }
    dispatch({ type: 'CONFIG', payload });
    trackOnboarding({
      event: 'config_saved',
      sessionId: state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const startCheckout = useCallback(async (): Promise<string | null> => {
    const res = await fetch('/api/public/billing/checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        productTier: state.productTier,
        email: state.email,
        config: state.config,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      checkoutUrl?: string;
      clientProductId?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `checkout_failed_${res.status}`);
    }
    if (data.checkoutUrl && data.clientProductId) {
      dispatch({
        type: 'CHECKOUT',
        payload: { checkoutUrl: data.checkoutUrl, clientProductId: data.clientProductId },
      });
      trackOnboarding({
        event: 'checkout_started',
        sessionId: state.sessionId,
        ts: now(),
      });
      return data.checkoutUrl;
    }
    return null;
  }, [state.config, state.email, state.productTier, state.sessionId]);

  const activate = useCallback(async (payload: ActivationPayload) => {
    dispatch({ type: 'ACTIVATE', payload });
    trackOnboarding({
      event: 'activated',
      sessionId: state.sessionId,
      ts: payload.activatedAt ?? now(),
    });
  }, [state.sessionId]);

  const abort = useCallback(async (payload: AbortedPayload) => {
    dispatch({ type: 'ABORT', payload });
    trackOnboarding({
      event: 'abandoned',
      reason: payload.reason,
      sessionId: state.sessionId,
      ts: now(),
    });
  }, [state.sessionId]);

  const reset = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    dispatch({ type: 'RESET' });
  }, []);

  const hasReachedStep = useCallback((step: WizardStep) => {
    if (step === 'signup') return true;
    const idx = WIZARD_STEPS.indexOf(step);
    return WIZARD_STEPS.slice(0, idx).every((s) => Boolean(state.stepCompletedAt[s]));
  }, [state.stepCompletedAt]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      state,
      setStep,
      completeStep,
      signup,
      selectProduct,
      saveConfig,
      startCheckout,
      activate,
      abort,
      reset,
      hasReachedStep,
    }),
    [state, setStep, completeStep, signup, selectProduct, saveConfig, startCheckout, activate, abort, reset, hasReachedStep],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return ctx;
}
