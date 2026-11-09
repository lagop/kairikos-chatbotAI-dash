'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { QuoterData } from '@/lib/premium-quoter-engine';

// 09/11/2026 — los ajustes del presupuestador. Lo que cambia cada semana (las
// plazas, el descuento, publicarlo) tiene su campo; el resto de textos y
// precios se edita en el JSON. Las dos cosas son la misma copia de los datos:
// tocar un campo reescribe el JSON, y lo que se guarda es siempre el JSON.

export interface QuoterVersionRow {
  version: number;
  note: string | null;
  operatorEmail: string | null;
  createdAt: string;
}

const FECHA = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PremiumQuoterSettingsPanel({ initialData, version, versions }: { initialData: QuoterData; version: number; versions: QuoterVersionRow[] }) {
  const router = useRouter();
  const [text, setText] = useState(() => JSON.stringify(initialData, null, 2));
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let parsed: QuoterData | null = null;
  try {
    parsed = JSON.parse(text) as QuoterData;
  } catch {
    parsed = null;
  }
  const launch = parsed?.config?.launch;

  function patchConfig(change: (data: QuoterData) => void) {
    if (!parsed) return;
    const copy = JSON.parse(text) as QuoterData;
    change(copy);
    setText(JSON.stringify(copy, null, 2));
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setProblems([]);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/portal/presupuestador', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ basedOn: version, ...body }),
      });
      const json = (await res.json().catch(() => ({}))) as { version?: number; problems?: string[]; error?: string };
      if (res.ok) {
        setMessage(`Guardado como versión ${json.version}.`);
        setNote('');
        router.refresh();
      } else if (json.error === 'conflict') {
        setProblems(['Otra persona ha guardado mientras editabas. Recarga la página y vuelve a aplicar tus cambios.']);
      } else {
        setProblems(json.problems ?? ['No se ha podido guardar.']);
      }
    } catch {
      setProblems(['No se ha podido guardar. Comprueba la conexión.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="premium-quoter-settings">
      <section className="card space-y-4">
        <h2 className="text-base font-semibold">Lo que más se toca</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={parsed?.config?.published ?? false}
            disabled={!parsed}
            onChange={(e) => patchConfig((d) => void (d.config.published = e.target.checked))}
            data-testid="quoter-published"
          />
          Publicado: cualquiera puede verlo en /web-premium
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={launch?.enabled ?? false} disabled={!parsed} onChange={(e) => patchConfig((d) => void (d.config.launch.enabled = e.target.checked))} />
          Precio de lanzamiento activo
        </label>
        <div className="flex flex-wrap gap-4">
          <label className="text-sm">
            <span className="block text-kairikos-muted">Plazas que quedan</span>
            <input
              className="input mt-1 w-28"
              type="number"
              min={0}
              value={launch?.spotsLeft ?? 0}
              disabled={!parsed}
              onChange={(e) => patchConfig((d) => void (d.config.launch.spotsLeft = Number(e.target.value)))}
              data-testid="quoter-spots"
            />
          </label>
          <label className="text-sm">
            <span className="block text-kairikos-muted">Descuento de lanzamiento (%)</span>
            <input
              className="input mt-1 w-28"
              type="number"
              min={0}
              max={90}
              value={Math.round((launch?.discount ?? 0) * 100)}
              disabled={!parsed}
              onChange={(e) => patchConfig((d) => void (d.config.launch.discount = Number(e.target.value) / 100))}
            />
          </label>
        </div>
        <a className="btn-ghost inline-block text-sm" href="/web-premium" target="_blank" rel="noreferrer">
          Ver la página →
        </a>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-semibold">Todos los datos</h2>
        <p className="text-sm text-kairikos-muted">
          Una opción con <code>catalog</code> toma su precio del catálogo; dentro de un texto, <code>{'{chatbot.starter.mes}'}</code> pone ese importe. En titulares y recomendaciones valen{' '}
          <code>&lt;em&gt;</code> y <code>&lt;b&gt;</code>.
        </p>
        <textarea className="input h-96 w-full font-mono text-xs" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} data-testid="quoter-json" />
        {parsed ? null : <p className="text-sm text-kairikos-danger">El JSON no es válido.</p>}
        <input className="input w-full" placeholder="Qué has cambiado (opcional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        {problems.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-kairikos-danger" data-testid="quoter-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {message ? <p className="text-sm text-kairikos-success">{message}</p> : null}
        <button type="button" className="btn-primary" disabled={busy || !parsed} onClick={() => post({ data: parsed, note: note || undefined })} data-testid="quoter-save">
          Guardar versión nueva
        </button>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-semibold">Versiones</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-kairikos-muted">Todavía nadie ha guardado nada: son los datos de fábrica.</p>
        ) : (
          <ul className="divide-y divide-kairikos-border">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <strong>v{v.version}</strong> · {FECHA.format(new Date(v.createdAt))}
                  {v.operatorEmail ? ` · ${v.operatorEmail}` : ''}
                  {v.note ? ` · ${v.note}` : ''}
                </span>
                {v.version === version ? (
                  <span className="pill-success">Vigente</span>
                ) : (
                  <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => post({ restoreVersion: v.version })}>
                    Volver a esta
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
