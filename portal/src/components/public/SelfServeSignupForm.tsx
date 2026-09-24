'use client';

import { useId, useMemo, useState } from 'react';

// =============================================================================
// WP-31 — the public signup form.
//
// Revisión de seguridad del 22/09/2026 — verificar antes de pagar. Este
// formulario ya solo hace el paso 1 (POST /api/public/self-serve-signup,
// que crea la cuenta con la contraseña bloqueada y manda el enlace). Entrar
// y pagar (o pedir presupuesto) ocurre después, en /portal/verify-email,
// cuando el enlace demuestra que el buzón es de quien se registra — ver
// continue-to-purchase.ts. La ruta contesta igual si el email ya tenía
// cuenta, así que aquí tampoco hay un mensaje de "ya existe": en los dos
// casos se pide revisar el correo.
// =============================================================================

export interface SignupTierOption {
  productId: string;
  code: string;
  label: string;
  tier: string;
  tierLabel: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
  // 'web' only (WP-31 follow-up): no fixed catalog price — the final
  // step is a free quote request (POST /api/portal/web-quote/request),
  // not a Stripe Checkout Session. See the onSubmit branch below.
  requiresQuote: boolean;
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

function priceSummary(tier: SignupTierOption): string {
  // 'web' has a real setupFeeCents on the Product row, but the actual
  // price is negotiated per project via WebQuote once the operator
  // reviews the brief — showing that number here would read as a fixed
  // price it isn't. Same "a medida" framing RequestWebQuoteCard already
  // uses inside the portal.
  if (tier.requiresQuote) return 'A medida — sin compromiso';
  const recurring = tier.priceCents > 0 ? `${formatPrice(tier.priceCents, tier.currency)}/mes` : null;
  const setup = tier.setupFeeCents > 0 ? `${formatPrice(tier.setupFeeCents, tier.currency)} de alta` : null;
  if (recurring && setup) return `${recurring} + ${setup}`;
  if (recurring) return recurring;
  if (setup) return `${setup} · pago único`;
  return 'Precio a confirmar';
}

type Step = 'idle' | 'creating_account' | 'check_email';

export function SelfServeSignupForm({
  tiers,
  codigoInicial = '',
}: {
  tiers: SignupTierOption[];
  /** A7 — el código que venía en ?ref= del enlace del socio. Se resuelve en
   *  el servidor y llega ya escrito: quien entra por el cartel de un almacén
   *  no tiene que teclear nada, y quien no, ve el campo vacío y opcional. */
  codigoInicial?: string;
}) {
  const id = useId();
  const byCode = useMemo(() => {
    const map = new Map<string, SignupTierOption[]>();
    for (const t of tiers) {
      const list = map.get(t.code) ?? [];
      list.push(t);
      map.set(t.code, list);
    }
    return map;
  }, [tiers]);

  const [selectedProductId, setSelectedProductId] = useState(tiers[0]?.productId ?? '');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot — stays empty for real visitors
  const [codigo, setCodigo] = useState(codigoInicial);
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = step === 'creating_account';

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!name.trim() || !companyName.trim()) {
      setError('Rellena tu nombre y el de tu empresa.');
      return;
    }
    if (!email.includes('@')) {
      setError('Introduce un email válido.');
      return;
    }
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (!tosAccepted) {
      setError('Tienes que aceptar los términos para continuar.');
      return;
    }
    if (!selectedProductId) {
      setError('Elige un producto.');
      return;
    }

    setStep('creating_account');
    try {
      const signupRes = await fetch('/api/public/self-serve-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name,
          companyName,
          password,
          productId: selectedProductId,
          tosAccepted,
          website,
          codigo: codigo.trim() || undefined,
        }),
      });
      if (!signupRes.ok) {
        const detail = await signupRes.json().catch(() => null);
        setError(
          signupRes.status === 429
            ? 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.'
            : `No se pudo crear la cuenta. ${detail?.error ?? signupRes.statusText}`,
        );
        setStep('idle');
        return;
      }
      setStep('check_email');
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setStep('idle');
    }
  }

  const selectedRequiresQuote = tiers.find((t) => t.productId === selectedProductId)?.requiresQuote ?? false;

  const buttonLabel =
    step === 'creating_account'
      ? 'Creando tu cuenta…'
      : selectedRequiresQuote
        ? 'Crear cuenta y solicitar presupuesto'
        : 'Crear cuenta y contratar';

  if (step === 'check_email') {
    return (
      <div className="card space-y-3 text-center" role="status" data-testid="empezar-check-email">
        <h2 className="text-lg font-semibold">Revisa tu correo</h2>
        <p className="text-sm text-kairikos-muted">
          Te hemos enviado un enlace a <strong className="text-kairikos-text">{email}</strong>. Púlsalo para activar tu
          cuenta y {selectedRequiresQuote ? 'enviar tu solicitud de presupuesto' : 'completar el pago'}.
        </p>
        <p className="text-xs text-kairikos-muted">
          ¿No te llega en unos minutos? Mira en spam. Si ya tenías una cuenta con este correo, te hemos escrito con
          cómo entrar.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-5" noValidate>
      <fieldset className="space-y-3">
        <legend className="label">Producto</legend>
        {Array.from(byCode.entries()).map(([code, codeTiers]) => (
          <label
            key={code}
            // has-[input[type=radio]:checked], not the broader
            // has-[:checked]: `:checked` also matches a <select>'s
            // currently selected <option> — always true for every
            // multi-tier card the moment it renders, radio state or
            // not — so the generic selector highlighted every card
            // with a tier dropdown (Chatbot, Prospección, Reseñas)
            // regardless of which product was actually selected.
            className="flex items-center justify-between gap-3 rounded-lg border border-kairikos-border p-3 has-[input[type=radio]:checked]:border-kairikos-accent2"
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="product"
                value={codeTiers[0].productId}
                checked={codeTiers.some((t) => t.productId === selectedProductId)}
                onChange={() => setSelectedProductId(codeTiers[0].productId)}
              />
              <span className="text-sm font-medium">{codeTiers[0].label}</span>
            </span>
            {codeTiers.length > 1 ? (
              <select
                className="input w-auto"
                value={codeTiers.some((t) => t.productId === selectedProductId) ? selectedProductId : codeTiers[0].productId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                data-testid={`empezar-tier-select-${code}`}
              >
                {codeTiers.map((t) => (
                  <option key={t.productId} value={t.productId}>
                    {t.tierLabel} · {priceSummary(t)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-kairikos-muted">{priceSummary(codeTiers[0])}</span>
            )}
          </label>
        ))}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-name`} className="label">
            Tu nombre
          </label>
          <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div>
          <label htmlFor={`${id}-company`} className="label">
            Empresa
          </label>
          <input
            id={`${id}-company`}
            className="input"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            autoComplete="organization"
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-email`} className="label">
          Email
        </label>
        <input
          id={`${id}-email`}
          type="email"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          inputMode="email"
        />
      </div>
      <div>
        <label htmlFor={`${id}-password`} className="label">
          Contraseña
        </label>
        <input
          id={`${id}-password`}
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mínimo 8 caracteres"
          autoComplete="new-password"
          minLength={8}
          data-testid="password-input"
        />
      </div>

      {/* A7 — opcional y el último campo, a propósito: preguntar "¿quién te
          mandó?" antes del correo hace que parezca un requisito. El código no
          se valida aquí ni puede romper el alta; si no existe, el servidor lo
          apunta como no atribuido y la cuenta se crea igual. */}
      <div>
        <label htmlFor={`${id}-codigo`} className="label">
          Código de socio o de recomendación <span className="text-kairikos-muted">(opcional)</span>
        </label>
        <input
          id={`${id}-codigo`}
          className="input font-mono uppercase"
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="Si alguien te recomendó Kairikos"
          autoComplete="off"
          maxLength={40}
          data-testid="codigo-input"
        />
      </div>

      {/* Honeypot — hidden from real visitors, real bots often fill every field they see */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      <label className="flex items-start gap-2 text-xs text-kairikos-muted">
        <input type="checkbox" checked={tosAccepted} onChange={(e) => setTosAccepted(e.target.checked)} className="mt-0.5" />
        <span>
          Acepto los{' '}
          <a className="underline" href="https://www.kairikos.com/terminos" target="_blank" rel="noreferrer">
            términos del servicio
          </a>{' '}
          y la{' '}
          <a className="underline" href="https://www.kairikos.com/privacidad" target="_blank" rel="noreferrer">
            política de privacidad
          </a>
          .
        </span>
      </label>

      {error ? (
        <p role="alert" data-testid="empezar-error" className="text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn-primary w-full" disabled={busy} data-testid="empezar-submit">
        {buttonLabel}
      </button>
    </form>
  );
}
