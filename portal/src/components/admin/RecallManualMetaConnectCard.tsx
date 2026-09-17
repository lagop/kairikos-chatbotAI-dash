'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from '@/components/portal/TotpStepUpModal';

// =============================================================================
// Conexión manual del WhatsApp de una suscripción de recall, para el operador.
// Ver connectRecallWhatsappManually (lib/recall-meta.ts): existe mientras la
// app de Meta no es Tech Provider y el registro insertado no puede dar de alta
// a nadie.
//
// El token se envía una vez y se borra del formulario en cuanto la respuesta
// llega, salga bien o mal. Nunca se vuelve a mostrar.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  token_not_verifiable: 'No se pudo comprobar el token con Meta. Inténtalo de nuevo en un momento.',
  token_invalid: 'Meta dice que ese token no es válido (caducado, revocado o mal copiado).',
  short_lived_token:
    'Ese token caduca en menos de 7 días. Usa un token de usuario del sistema (Business Manager → Usuarios del sistema), que no caduca.',
  missing_permissions: 'Al token le faltan permisos',
  waba_not_accessible: 'Con ese token no se puede leer esa cuenta de WhatsApp. Revisa el ID y que el usuario del sistema tenga asignada la cuenta',
  phone_not_in_waba: 'Ese ID de número no pertenece a esa cuenta de WhatsApp.',
  invalid_status: 'Esta suscripción no admite conectar WhatsApp en su estado actual.',
  subscription_not_found: 'No se encontró la suscripción.',
  invalid_body: 'Revisa los campos: los dos IDs son solo números y el token tiene que estar completo.',
  operator_session_required: 'Hace falta iniciar sesión como operador.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  persist_failed: 'Meta lo aceptó pero no se pudo guardar. Inténtalo de nuevo.',
  internal_error: 'Algo falló en el servidor.',
};

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function RecallManualMetaConnectCard({
  subscriptionId,
  connectionStatus,
}: {
  subscriptionId: string;
  /** Estado de la conexión actual, o null si no hay. */
  connectionStatus: string | null;
}) {
  const router = useRouter();
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [stepUp, setStepUp] = useState<null | { onVerified: () => void; onCancel: () => void }>(null);

  const ready = /^\d{5,25}$/.test(wabaId.trim()) && /^\d{5,25}$/.test(phoneNumberId.trim()) && token.trim().length >= 20;

  async function submit() {
    setMessage(null);
    setBusy(true);
    let res: Response;
    try {
      res = await fetch(`/api/admin/portal/recall/${subscriptionId}/meta-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wabaId: wabaId.trim(), phoneNumberId: phoneNumberId.trim(), accessToken: token.trim() }),
      });
    } catch (err) {
      setBusy(false);
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
      return;
    }
    setBusy(false);
    const body = await safeJson(res);

    if (res.status === 403 && body.error === 'totp_step_up_required') {
      // El token se conserva solo mientras se verifica el segundo factor.
      setStepUp({
        onVerified: () => {
          setStepUp(null);
          void submit();
        },
        onCancel: () => setStepUp(null),
      });
      return;
    }

    setToken('');
    if (!res.ok) {
      const code = body.error as string;
      const base = ERROR_LABEL[code] ?? 'No se pudo conectar';
      const text = base.endsWith('.')
        ? base
        : typeof body.detail === 'string'
          ? `${base}: ${body.detail}`
          : `${base}.`;
      setMessage({ kind: 'error', text });
      return;
    }
    const number = typeof body.displayPhoneNumber === 'string' ? ` (${body.displayPhoneNumber})` : '';
    setMessage({
      kind: 'ok',
      text: `WhatsApp conectado${number}. Las plantillas se envían a Meta en el próximo ciclo; guarda ahora el WhatsApp del dueño para que le lleguen los códigos de desvío.`,
    });
    router.refresh();
  }

  return (
    <details className="mt-4 rounded-xl border border-kairikos-border p-4" data-testid="recall-manual-meta">
      <summary className="cursor-pointer text-sm font-semibold">
        Conectar WhatsApp a mano (sin registro insertado)
        {connectionStatus && connectionStatus !== 'active' ? (
          <span className="pill-danger ml-2">La conexión actual no funciona</span>
        ) : null}
      </summary>

      <div className="mt-3 space-y-3">
        <p className="text-sm text-kairikos-muted">
          Para cuando la ventana de Meta no puede dar de alta clientes (la app aún no es Tech Provider). Usa una cuenta de
          WhatsApp Business que controles tú. <strong>El número funciona solo por la API, no en la app del móvil a la
          vez</strong>, y tiene que estar ya registrado en Meta.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-kairikos-muted">
          <li>
            En el Business Manager: <strong>Usuarios del sistema</strong> → crea uno (administrador) → asígnale la app{' '}
            <em>Kairikos_dashboard</em> y la cuenta de WhatsApp.
          </li>
          <li>
            <strong>Generar token</strong> → app <em>Kairikos_dashboard</em> → caducidad <strong>Nunca</strong> → permisos{' '}
            <code>whatsapp_business_management</code> y <code>whatsapp_business_messaging</code>.
          </li>
          <li>
            Los IDs están en la app, <strong>WhatsApp → Configuración de la API</strong>: «Identificador de la cuenta de
            WhatsApp Business» e «Identificador del número de teléfono».
          </li>
        </ol>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">ID de la cuenta de WhatsApp Business</span>
            <input
              className="input w-full font-mono"
              inputMode="numeric"
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
              autoComplete="off"
              data-testid="recall-manual-waba"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">ID del número de teléfono</span>
            <input
              className="input w-full font-mono"
              inputMode="numeric"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              autoComplete="off"
              data-testid="recall-manual-phone"
            />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Token del usuario del sistema</span>
          <input
            type="password"
            className="input w-full font-mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            data-testid="recall-manual-token"
          />
          <span className="block text-xs text-kairikos-muted">
            Se guarda cifrado y no se vuelve a mostrar. Se pide verificación en dos pasos.
          </span>
        </label>

        <button
          type="button"
          className="btn-primary"
          disabled={!ready || busy}
          onClick={submit}
          data-testid="recall-manual-submit"
        >
          {busy ? 'Comprobando con Meta…' : 'Comprobar y conectar'}
        </button>

        {message ? (
          <p
            role="status"
            className={`text-sm ${message.kind === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}
            data-testid="recall-manual-message"
          >
            {message.text}
          </p>
        ) : null}
      </div>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </details>
  );
}
