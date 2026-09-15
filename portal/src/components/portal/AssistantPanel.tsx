'use client';

import { useRef, useState } from 'react';

// =============================================================================
// Fase 5c — la interfaz del asistente.
//
// LOS DATOS SE PINTAN, NO SE NARRAN. La respuesta del servidor trae
// `{narrative, component}` separados a propósito: la frase la escribe el
// modelo, y los números los pinta este componente a partir de datos
// estructurados. Volcarlo todo en prosa es el error que hace inútil un
// asistente por chat —un muro de texto que hay que leer entero para
// encontrar un importe— y es justo lo que este formato evita.
//
// LAS PREGUNTAS FRECUENTES SON BOTONES, Y NO POR COMODIDAD. Un botón manda
// la intención directa: no gasta una llamada al modelo, no puede
// entenderse mal, y contesta en el tiempo de una consulta a la base en vez
// de en el de una inferencia. El texto libre existe para lo que no cabe en
// un botón, no como vía principal.
//
// Y hace que el asistente siga sirviendo SIN clave de Anthropic: los
// botones funcionan igual, solo se pierde entender preguntas escritas.
//
// NO HAY HISTORIAL DE CONVERSACIÓN, y es deliberado. Cada pregunta se
// responde sola: no hay "¿y el mes pasado?" que dependa de la anterior.
// Un hilo daría a entender que el asistente recuerda, y el catálogo
// cerrado no tiene memoria — prometerlo en la interfaz sería prometer algo
// que el motor no hace.
// =============================================================================

interface ComponentItem {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

interface ComponentMetric {
  label: string;
  value: string;
  hint?: string;
}

interface AssistantComponent {
  kind: 'list' | 'metric' | 'card' | 'empty';
  items?: ComponentItem[];
  metrics?: ComponentMetric[];
}

interface AssistantAnswer {
  narrative: string;
  component: AssistantComponent;
  reason?: string;
}

/** Las preguntas que se ofrecen como botón, con la intención que mandan.
 *  Deliberadamente pocas: una rejilla de nueve opciones es un menú, y un
 *  menú no es un asistente. Estas cuatro son las que un dueño de negocio
 *  se pregunta a diario. */
const QUICK: Array<{ intent: string; label: string }> = [
  { intent: 'daily_brief', label: '¿Cómo va el día?' },
  { intent: 'pending_quotes', label: 'Presupuestos pendientes' },
  { intent: 'missed_calls_open', label: 'Llamadas sin devolver' },
  { intent: 'upcoming_recalls', label: 'Revisiones que vencen' },
];

export function AssistantPanel() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Para devolver el foco al campo tras un botón: en móvil evita que el
  // teclado baje y suba en cada consulta.
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = async (payload: { question?: string; intent?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(
          res.status === 401
            ? 'Tu sesión ha caducado. Vuelve a entrar.'
            : 'No he podido consultarlo. Inténtalo en un momento.',
        );
        return;
      }
      setAnswer((await res.json()) as AssistantAnswer);
    } catch {
      setError('No he podido consultarlo. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    void ask({ question: trimmed });
  };

  return (
    <div className="space-y-4" data-testid="assistant-panel">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pregúntame por tus presupuestos, llamadas o revisiones"
          className="input flex-1 min-w-0"
          disabled={busy}
          data-testid="assistant-input"
          // Un asistente de negocio no necesita que el móvil le corrija
          // "García" ni le ponga mayúscula a "presupuestos".
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <button type="submit" className="btn-primary" disabled={busy || !question.trim()}>
          {busy ? 'Consultando…' : 'Preguntar'}
        </button>
      </form>

      <div className="flex flex-wrap gap-2" data-testid="assistant-quick">
        {QUICK.map((q) => (
          <button
            key={q.intent}
            type="button"
            className="rounded-full border border-kairikos-border px-3 py-1 text-sm text-kairikos-muted hover:text-kairikos-text disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setQuestion('');
              void ask({ intent: q.intent });
              inputRef.current?.focus();
            }}
            data-testid={`assistant-quick-${q.intent}`}
          >
            {q.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert" data-testid="assistant-error">
          {error}
        </p>
      ) : null}

      {answer ? <Answer answer={answer} /> : null}
    </div>
  );
}

function Answer({ answer }: { answer: AssistantAnswer }) {
  return (
    // aria-live para que un lector de pantalla anuncie la respuesta: el
    // contenido cambia sin que la página navegue a ningún sitio.
    <div className="space-y-3" aria-live="polite" data-testid="assistant-answer">
      <p className="text-sm" data-testid="assistant-narrative">
        {answer.narrative}
      </p>

      {answer.component.kind === 'metric' && answer.component.metrics ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {answer.component.metrics.map((m) => (
            <div key={m.label} className="card p-4">
              <dt className="text-xs uppercase tracking-wide text-kairikos-muted">{m.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{m.value}</dd>
              {m.hint ? <p className="mt-1 text-xs text-kairikos-muted">{m.hint}</p> : null}
            </div>
          ))}
        </dl>
      ) : null}

      {answer.component.kind === 'list' && answer.component.items?.length ? (
        <ul className="card divide-y divide-kairikos-border">
          {answer.component.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.title}</p>
                {item.subtitle ? (
                  <p className="truncate text-xs text-kairikos-muted">{item.subtitle}</p>
                ) : null}
              </div>
              {item.meta ? (
                <span className="shrink-0 text-xs tabular-nums text-kairikos-muted">{item.meta}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
