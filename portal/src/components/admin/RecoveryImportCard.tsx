'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Recuperación dentro de `recall` — importar los datos pasados de un cliente,
// o diagnosticar el fichero de un prospecto.
//
// UN MISMO COMPONENTE PARA LOS DOS USOS, porque la primera mitad es idéntica
// (subir el fichero y ver qué se entiende de él) y solo cambia si al final
// hay botón de importar. En modo diagnóstico no lo hay, y no es un detalle:
// el prospecto todavía no es cliente, no hay suscripción a la que importar,
// y no se guarda nada.
//
// EL FICHERO SE LEE EN EL NAVEGADOR y se manda como texto, no como subida
// multipart. Son CSV de unos cientos de KB; leerlos aquí evita montar un
// almacén temporal en el servidor para algo que se procesa en una sola
// petición y no se conserva.
//
// LA DECLARACIÓN SE MUESTRA ENTERA ANTES DEL BOTÓN, y el botón no se
// habilita sin marcar la casilla. El texto que se enseña lo manda el
// servidor en la vista previa: es el mismo que quedará guardado, así que
// lo que el operador ve es exactamente lo que se registra.
// =============================================================================

interface Quality {
  totalRows: number;
  withValidPhone: number;
  withName: number;
  withDate: number;
  withAmount: number;
  duplicatesInFile: number;
  score: number;
}

interface PreviewRow {
  rowNumber: number;
  e164: string | null;
  name: string | null;
  lastServiceAt: string | null;
  serviceType: string | null;
  amount: number | null;
  skipReason: string | null;
}

interface Analysis {
  summary: string;
  quality: Quality;
  diagnostic: { usableContacts: number; dormantContacts: number; overdueServices: number; totalBilled: number };
  mapping: Record<string, string>;
  preview: PreviewRow[];
  declaration?: string;
}

interface ImportResult {
  contactsCreated: number;
  contactsUpdated: number;
  jobsCreated: number;
  rowsSkipped: number;
}

const FIELD_LABEL: Record<string, string> = {
  phone: 'Teléfono',
  name: 'Nombre',
  email: 'Email',
  lastServiceAt: 'Fecha del servicio',
  serviceType: 'Servicio',
  amount: 'Importe',
  nextServiceAt: 'Próxima revisión',
  address: 'Dirección',
};

const ERROR_LABEL: Record<string, string> = {
  declaration_not_accepted_or_bad_request: 'Marca que el cliente ha aceptado la declaración antes de importar.',
  subscription_not_found: 'No se encuentra la suscripción de este cliente.',
};

const pct = (n: number, total: number) => (total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`);

export function RecoveryImportCard({ subscriptionId }: { subscriptionId: string | null }) {
  const router = useRouter();
  const diagnosticOnly = subscriptionId === null;

  const [csv, setCsv] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const onFile = async (file: File | undefined) => {
    setAnalysis(null);
    setResult(null);
    setAccepted(false);
    setError(null);
    if (!file) return;

    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setBusy(true);
    try {
      const url = diagnosticOnly
        ? '/api/admin/portal/recall/diagnostic'
        : `/api/admin/portal/recall/${subscriptionId}/import/preview`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setError(ERROR_LABEL[json?.error] ?? 'No se ha podido leer el fichero.');
        return;
      }
      setAnalysis(json as Analysis);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!csv || !accepted || diagnosticOnly) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/portal/recall/${subscriptionId}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv, filename, clientAccepted: true }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        // La importación NO es transaccional: si falla a mitad, lo ya escrito
        // se queda. Lo que sí es cierto —y es lo que hay que decir— es que
        // repetirla es seguro, porque ni los contactos ni los trabajos se
        // duplican (ver commitImport).
        setError(
          ERROR_LABEL[json?.error] ??
            'La importación se ha interrumpido y puede haber quedado a medias. Vuelve a lanzarla con el mismo fichero: no duplica contactos ni trabajos.',
        );
        return;
      }
      setResult(json as ImportResult);
      setAnalysis(null);
      setCsv(null);
      setAccepted(false);
      // Los contadores de candidatos de las campañas cambian con la
      // importación: se refresca la página para que no enseñen los de antes.
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-4" data-testid={diagnosticOnly ? 'recovery-diagnostic' : 'recovery-import'}>
      <div>
        <h2 className="text-base font-semibold">
          {diagnosticOnly ? 'Diagnóstico de un fichero' : 'Importar clientes pasados'}
        </h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          {diagnosticOnly
            ? 'Sube el export de facturación de un prospecto y enséñale su propio dinero. No se guarda nada.'
            : 'Mejor el export del programa de facturación que el de un CRM: acredita que fueron clientes reales y qué contrataron.'}
        </p>
      </div>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void onFile(e.target.files?.[0])}
        disabled={busy}
        data-testid="recovery-import-file"
        className="block text-sm"
      />

      {busy && !analysis ? <p className="text-sm text-kairikos-muted">Leyendo el fichero…</p> : null}

      {error ? (
        <p className="text-sm text-kairikos-danger" role="alert" data-testid="recovery-import-error">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="rounded-xl border border-kairikos-border px-4 py-3 text-sm" data-testid="recovery-import-result">
          Importado: <strong>{result.contactsCreated}</strong> contactos nuevos, {result.contactsUpdated} actualizados,{' '}
          {result.jobsCreated} trabajos. {result.rowsSkipped > 0 ? `${result.rowsSkipped} filas sin teléfono se han saltado.` : ''}
        </div>
      ) : null}

      {analysis ? (
        <div className="space-y-4" data-testid="recovery-import-analysis">
          <p className="text-sm font-medium">{analysis.summary}</p>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Calidad', value: `${analysis.quality.score}%` },
              { label: 'Con teléfono', value: pct(analysis.quality.withValidPhone, analysis.quality.totalRows) },
              { label: 'Con fecha', value: pct(analysis.quality.withDate, analysis.quality.totalRows) },
              { label: 'Con importe', value: pct(analysis.quality.withAmount, analysis.quality.totalRows) },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-kairikos-border p-3">
                <dt className="text-xs uppercase tracking-wide text-kairikos-muted">{m.label}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">{m.value}</dd>
              </div>
            ))}
          </dl>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-kairikos-muted">Cómo se ha entendido cada columna</h3>
            <p className="mt-1 text-sm">
              {Object.entries(analysis.mapping).length === 0
                ? 'No se ha reconocido ninguna columna. Revisa que la primera fila sean las cabeceras.'
                : Object.entries(analysis.mapping)
                    .map(([field, column]) => `${FIELD_LABEL[field] ?? field} ← «${column}»`)
                    .join(' · ')}
            </p>
            {!analysis.mapping.phone ? (
              <p className="mt-1 text-sm text-kairikos-danger">
                No se ha encontrado la columna del teléfono: sin ella no se puede importar a nadie.
              </p>
            ) : null}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-kairikos-muted">
                  <th className="py-1 pr-3">Fila</th>
                  <th className="py-1 pr-3">Teléfono</th>
                  <th className="py-1 pr-3">Nombre</th>
                  <th className="py-1 pr-3">Fecha</th>
                  <th className="py-1 pr-3">Importe</th>
                </tr>
              </thead>
              <tbody>
                {analysis.preview.map((row) => (
                  <tr key={row.rowNumber} className="border-t border-kairikos-border">
                    <td className="py-1 pr-3 tabular-nums">{row.rowNumber}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.e164 ?? <span className="text-kairikos-danger">sin teléfono válido</span>}</td>
                    <td className="py-1 pr-3">{row.name ?? '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.lastServiceAt ? row.lastServiceAt.slice(0, 10) : '—'}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.amount ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!diagnosticOnly && analysis.declaration ? (
            <div className="space-y-3 rounded-xl border border-kairikos-border p-4">
              <p className="text-sm italic">«{analysis.declaration}»</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  data-testid="recovery-import-accept"
                  className="mt-1"
                />
                <span>
                  El cliente ha aceptado esta declaración. Sin ella no se le puede escribir a ninguno de estos contactos,
                  porque nunca recibieron el aviso de oposición.
                </span>
              </label>
              <button
                type="button"
                className="btn-primary"
                onClick={commit}
                disabled={!accepted || busy || !analysis.mapping.phone}
                data-testid="recovery-import-commit"
              >
                {busy ? 'Importando…' : `Importar ${analysis.diagnostic.usableContacts} contactos`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
