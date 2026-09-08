'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HandoffState } from '@/lib/chatbot-handoff';

// =============================================================================
// Fase 3 — donde una persona retoma una conversación del bot.
//
// Tres gestos: tomarla (el bot se calla), contestar, y devolverla al bot.
// Se exige tomarla antes de contestar a propósito: si dos personas del
// mismo negocio abren la misma conversación, la segunda ve que ya la tiene
// alguien en vez de escribir encima.
//
// El canal web no admite respuesta y se dice, en vez de enseñar un botón
// que falla: el widget es una página del navegador que ya se cerró, no hay
// ninguna API a la que enviar. Ver chatbot-handoff.ts.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  already_taken: 'Otra persona acaba de tomar esta conversación.',
  not_taken: 'Toma primero la conversación para poder contestar.',
  channel_not_supported: 'Por este canal no podemos enviar respuestas.',
  no_recipient: 'No sabemos a qué contacto responder en esta conversación.',
  no_connection: 'El canal está desconectado. Vuelve a conectarlo en Canales.',
  send_failed: 'No se pudo entregar el mensaje. Inténtalo de nuevo.',
  conversation_not_found: 'Esta conversación ya no está.',
  not_found: 'Esta conversación ya no está.',
  invalid_body: 'Escribe un mensaje antes de enviarlo.',
  internal_error: 'Algo falló. Si persiste, contacta con el equipo técnico.',
};

export function HandoffReplyPanel({
  conversationId,
  state,
  takenBy,
  canSend,
  channel,
}: {
  conversationId: string;
  state: HandoffState;
  takenBy: string | null;
  /** false cuando el canal no admite envío saliente. */
  canSend: boolean;
  /** Para poder decir POR QUÉ no se puede responder sin inventárselo. */
  channel: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/conversations/${conversationId}/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string; takenBy?: string } | null;
        setError(ERROR_LABEL[json?.error ?? ''] ?? ERROR_LABEL.internal_error);
        // Refrescamos igualmente en el conflicto: el estado de la pantalla
        // está desactualizado y eso es justo lo que hay que corregir.
        if (json?.error === 'already_taken' || json?.error === 'not_taken') router.refresh();
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError(ERROR_LABEL.internal_error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!canSend) {
    return (
      <section className="card space-y-2" aria-label="Responder" data-testid="handoff-panel" data-state={state}>
        <p className="text-sm font-semibold">Esta conversación no admite respuesta</p>
        <p className="text-sm text-kairikos-muted">
          {/* Solo se afirma lo del chat de la web cuando el canal ES 'web'.
              Una conversación antigua sin canal guardado no sabemos por
              dónde entró, y decírselo igualmente sería inventárselo. */}
          {channel === 'web'
            ? 'Llegó por el chat de tu web, y esa ventana ya está cerrada: no hay a dónde enviar el mensaje. Si dejó su teléfono o su email, escríbele por ahí.'
            : 'No tenemos por dónde escribirle: esta conversación no llegó por un canal al que podamos responder. Si dejó su teléfono o su email, escríbele por ahí.'}
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-3" aria-label="Responder" data-testid="handoff-panel" data-state={state}>
      {state === 'taken' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill-success">La tienes tú</span>
            {takenBy ? <span className="text-xs text-kairikos-muted">{takenBy}</span> : null}
            <span className="text-xs text-kairikos-muted">· El bot no responderá mientras tanto.</span>
          </div>
          <textarea
            className="input min-h-[6rem]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe tu respuesta. Le llegará por el mismo canal por el que escribió."
            maxLength={4000}
            data-testid="handoff-text"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || text.trim().length === 0}
              data-testid="handoff-send"
              onClick={async () => {
                const ok = await act({ action: 'reply', text: text.trim() });
                if (ok) setText('');
              }}
            >
              {busy ? 'Enviando…' : 'Enviar'}
            </button>
            <button
              type="button"
              className="btn border border-kairikos-border"
              disabled={busy}
              data-testid="handoff-close"
              onClick={() => act({ action: 'close' })}
            >
              Devolver al bot
            </button>
            {error ? (
              <span className="text-sm text-kairikos-danger" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div>
            <p className="text-sm font-semibold">
              {state === 'pending' ? 'Tu bot ha pedido ayuda con esta conversación' : 'Responder tú a esta conversación'}
            </p>
            <p className="text-xs text-kairikos-muted">
              {state === 'pending'
                ? 'Mientras nadie la tome, el bot sigue respondiendo lo mejor que puede.'
                : 'Puedes tomarla aunque el bot no lo haya pedido: en cuanto lo hagas, dejará de responder.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              data-testid="handoff-take"
              onClick={() => act({ action: 'take' })}
            >
              {busy ? 'Un momento…' : 'Tomar la conversación'}
            </button>
            {error ? (
              <span className="text-sm text-kairikos-danger" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
