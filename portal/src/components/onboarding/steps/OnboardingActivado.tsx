'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useOnboarding } from '@/lib/onboarding/self-serve-context';

interface ActivationResponse {
  activated: boolean;
  activatedAt?: string;
  sessionId?: string;
  error?: string;
}

function ActivationInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, activate, setStep } = useOnboarding();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const triggered = useRef(false);

  useEffect(() => {
    setStep('activado');
  }, [setStep]);

  const sessionQuery = searchParams.get('session_id');
  const clientProductId = state.clientProductId;

  useEffect(() => {
    if (triggered.current) return;
    if (state.active) {
      setStatus('ready');
      return;
    }
    if (!clientProductId && !sessionQuery) {
      setStatus('error');
      setError('missing_session');
      return;
    }
    triggered.current = true;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch('/api/onboarding/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: state.sessionId,
            clientProductId,
            stripeSessionId: sessionQuery,
          }),
        });
        const data = (await res.json()) as ActivationResponse;
        if (!res.ok || !data.activated) {
          setStatus('error');
          setError(data.error ?? `activation_failed_${res.status}`);
          return;
        }
        await activate({ active: true, activatedAt: data.activatedAt });
        setStatus('ready');
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'activation_failed');
      }
    })();
  }, [clientProductId, sessionQuery, activate, state.sessionId, state.active]);

  const timeToActive = useMemo(() => {
    if (!state.stepCompletedAt.signup || !state.activatedAt) return null;
    const start = new Date(state.stepCompletedAt.signup).getTime();
    const end = new Date(state.activatedAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return { seconds, minutes, remaining };
  }, [state.activatedAt, state.stepCompletedAt.signup]);

  return (
    <div className="grid gap-6">
      <header className="space-y-1 text-center">
        <span className="pill-success mx-auto" aria-label="Activación correcta">
          Activación correcta
        </span>
        <h2 id="wizard-heading-activado" className="text-2xl font-semibold sm:text-3xl">
          Tu portal Kairikos está listo.
        </h2>
        <p className="text-sm text-kairikos-muted">
          Te hemos enviado un email de bienvenida. Tarda menos de 60 segundos en llegar.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <article className="card space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-kairikos-muted">
            Siguiente paso
          </h3>
          <p className="text-base font-semibold">Accede a tu portal</p>
          <p className="text-sm text-kairikos-muted">
            Usa el enlace mágico que te acabamos de enviar para entrar sin contraseña.
          </p>
          <Link
            href="/portal/login"
            className="btn-primary mt-2 w-full text-center"
            data-testid="activado-portal-link"
          >
            Ir al portal
          </Link>
        </article>
        <article className="card space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-kairikos-muted">
            Tiempo hasta activación
          </h3>
          {timeToActive ? (
            <p className="text-2xl font-bold" data-testid="activado-time">
              {timeToActive.minutes}m {timeToActive.remaining.toString().padStart(2, '0')}s
            </p>
          ) : (
            <p className="text-sm text-kairikos-muted">Calculando…</p>
          )}
          <p className="text-xs text-kairikos-muted">
            Objetivo: menos de 5 minutos. Si pasa, escribe a soporte.
          </p>
        </article>
      </div>

      {status === 'loading' ? (
        <p
          role="status"
          className="rounded-lg border border-kairikos-border bg-kairikos-surface2 px-3 py-2 text-sm text-kairikos-muted"
        >
          Confirmando el pago con Stripe…
        </p>
      ) : null}

      {status === 'error' ? (
        <div className="rounded-lg border border-kairikos-danger/40 bg-kairikos-danger/10 p-3 text-sm text-kairikos-danger">
          <p>
            No hemos podido confirmar tu activación ({error ?? 'desconocido'}). Si
            tu pago se ha completado, escríbenos a soporte y te ayudamos.
          </p>
          <button
            type="button"
            className="btn-ghost mt-3"
            onClick={() => {
              triggered.current = false;
              setStatus('idle');
              setError(null);
              router.refresh();
            }}
          >
            Reintentar
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function OnboardingActivado() {
  return (
    <Suspense fallback={<p role="status">Cargando…</p>}>
      <ActivationInner />
    </Suspense>
  );
}
