'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// 26/11/2026 — liberar el número de llamadas de un cliente dado de baja.
//
// Hasta ahora solo estaba la ruta (POST /api/admin/portal/recall/numbers/
// [id]/release), y había que llamarla con un fetch desde la consola del
// navegador. La baja de los datos (lib/client-data-exit.ts) no borra las
// llamadas mientras el número siga asignado, porque Twilio lo seguiría
// cobrando sin nada que lo enlace, y el cron avisa al operador para que lo
// libere: este es ese botón. La ruta ya deja el rastro (RecallSubscriptionAudit
// `number_released`, con el operador).
//
// Dos pasos: devolver el número a Twilio no tiene vuelta atrás (otro cliente
// de Twilio puede quedárselo), así que el primer clic solo pregunta.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  number_not_found: 'Ese número ya no existe.',
  already_released: 'Ya estaba liberado.',
  provider_failed: 'Twilio no lo ha liberado. Sigue asignado; prueba más tarde.',
  service_unavailable: 'La telefonía no está configurada en este portal.',
  unauthorized: 'Tu sesión de operador ha caducado. Vuelve a entrar.',
};

export function RecallReleaseNumberButton({ numberId, e164 }: { numberId: string; e164: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/portal/recall/numbers/${encodeURIComponent(numberId)}/release`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(ERROR_LABEL[body?.error] ?? 'No se pudo liberar. Inténtalo de nuevo.');
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="recall-release-number">
      {confirming ? (
        <>
          <span className="text-xs text-kairikos-text">
            ¿Devolver {e164} a Twilio? Deja de recibir llamadas y no se puede recuperar.
          </span>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={release}
            data-testid="recall-release-number-confirm"
          >
            {busy ? 'Liberando…' : 'Sí, liberar'}
          </button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancelar
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          data-testid="recall-release-number-button"
        >
          Liberar número
        </button>
      )}
      {error ? (
        <span className="text-xs text-kairikos-danger" data-testid="recall-release-number-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
