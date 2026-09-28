'use client';

import { useId, useState } from 'react';

// =============================================================================
// A5 — la calculadora de llamadas perdidas.
//
// Toda la aritmética está en el servidor (POST /api/public/calculadora, que
// reutiliza el mismo estimateMissedCallValue del informe comercial). Aquí no
// se multiplica nada a propósito: una copia del cálculo en el navegador es
// una copia que se desincroniza el día que se afina un sector, y el número
// de esta página es exactamente el que luego aparece en el informe.
//
// El contacto NO es obligatorio para ver el resultado. Cobrar el número con
// un email espanta a más gente de la que captura, y quien lo deja después de
// ver la cifra es un lead mucho mejor que quien lo deja antes.
// =============================================================================

export interface SectorOption {
  value: string;
  label: string;
}

interface Resultado {
  anual: number;
  mensual: number;
  supuestos: { missedCallsPerWeek: number; averageJobValue: number; closeRate: number };
}

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export function CalculadoraForm({ sectores }: { sectores: SectorOption[] }) {
  const id = useId();
  const [sector, setSector] = useState(sectores[0]?.value ?? 'otro');
  const [llamadas, setLlamadas] = useState('3');
  const [encargo, setEncargo] = useState('');
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  // Segundo paso, solo visible cuando ya hay un número en pantalla.
  const [contacto, setContacto] = useState('');
  const [negocio, setNegocio] = useState('');
  const [ciudad, setCiudad] = useState('');
  const [website, setWebsite] = useState(''); // campo trampa
  const [enviado, setEnviado] = useState(false);

  async function calcular(incluirContacto: boolean) {
    setError(null);
    setCalculando(true);
    try {
      const res = await fetch('/api/public/calculadora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sector,
          llamadasPerdidas: Number(llamadas) || 0,
          encargoMedio: encargo.trim() ? Number(encargo) : undefined,
          website,
          ...(incluirContacto
            ? { contacto: contacto.trim(), negocio: negocio.trim() || undefined, ciudad: ciudad.trim() || undefined }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError('No se pudo calcular. Revisa los datos e inténtalo otra vez.');
        return;
      }
      setResultado({ anual: data.anual, mensual: data.mensual, supuestos: data.supuestos });
      if (incluirContacto) setEnviado(true);
    } catch {
      setError('Error de red. Inténtalo otra vez en un momento.');
    } finally {
      setCalculando(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        className="card space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void calcular(false);
        }}
      >
        <div>
          <label className="label" htmlFor={`${id}-sector`}>
            ¿A qué te dedicas?
          </label>
          <select
            id={`${id}-sector`}
            className="input"
            value={sector}
            onChange={(e) => {
              setSector(e.target.value);
              // El encargo medio por defecto depende del sector, así que un
              // valor tecleado para fontanería no puede quedarse pegado al
              // elegir peluquería.
              setEncargo('');
              setResultado(null);
            }}
          >
            {sectores.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor={`${id}-llamadas`}>
            ¿Cuántas llamadas se te quedan sin contestar a la semana?
          </label>
          <input
            id={`${id}-llamadas`}
            className="input"
            type="number"
            min={0}
            max={200}
            step={1}
            value={llamadas}
            onChange={(e) => setLlamadas(e.target.value)}
            data-testid="calculadora-llamadas"
          />
          <p className="mt-1 text-xs text-kairikos-muted">
            Cuenta las que entran mientras estás trabajando, conduciendo o con otro cliente.
          </p>
        </div>

        <div>
          <label className="label" htmlFor={`${id}-encargo`}>
            Lo que te deja un encargo medio <span className="text-kairikos-muted">(opcional)</span>
          </label>
          <input
            id={`${id}-encargo`}
            className="input"
            type="number"
            min={0}
            step={10}
            value={encargo}
            onChange={(e) => setEncargo(e.target.value)}
            placeholder="Si lo dejas vacío usamos la media de tu sector"
          />
        </div>

        {/* Campo trampa: invisible para una persona, lo rellena un bot. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor={`${id}-website`}>Website</label>
          <input id={`${id}-website`} tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-kairikos-danger">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn-primary w-full" disabled={calculando}>
          {calculando ? 'Calculando…' : 'Ver cuánto me cuesta'}
        </button>
      </form>

      {resultado ? (
        <section className="card space-y-4" data-testid="calculadora-resultado" aria-live="polite">
          <p className="text-sm text-kairikos-muted">Las llamadas que no contestas te cuestan</p>
          <p className="text-4xl font-semibold tracking-tight">{EUR.format(resultado.anual)}</p>
          <p className="text-sm text-kairikos-muted">al año, unos {EUR.format(resultado.mensual)} al mes.</p>

          {/* Los supuestos SIEMPRE a la vista, igual que en el informe: la
              primera reacción a esta cifra es "yo no pierdo tanto", y hay
              que poder enseñar de dónde sale sin buscarlo. */}
          <div className="rounded border border-kairikos-border p-3 text-xs text-kairikos-muted">
            <p className="font-medium text-kairikos-text">De dónde sale este número</p>
            <ul className="mt-2 space-y-1">
              <li>{resultado.supuestos.missedCallsPerWeek} llamadas perdidas a la semana</li>
              <li>{EUR.format(resultado.supuestos.averageJobValue)} de encargo medio</li>
              <li>
                {Math.round(resultado.supuestos.closeRate * 100)} % de esas llamadas se habrían convertido en trabajo
              </li>
            </ul>
            <p className="mt-2">
              Son cifras conservadoras a propósito. Cambia las tuyas arriba y vuelve a calcular.
            </p>
          </div>

          {enviado ? (
            <p className="text-sm" role="status">
              Hecho. Te escribimos con el cálculo y con qué se puede hacer para dejar de perderlas.
            </p>
          ) : (
            <form
              className="space-y-3 border-t border-kairikos-border pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!contacto.trim()) {
                  setError('Déjanos un teléfono o un correo para poder escribirte.');
                  return;
                }
                void calcular(true);
              }}
            >
              <p className="text-sm font-medium">¿Te mandamos el cálculo y cómo dejar de perderlas?</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  className="input"
                  value={negocio}
                  onChange={(e) => setNegocio(e.target.value)}
                  placeholder="Nombre del negocio"
                  maxLength={200}
                  aria-label="Nombre del negocio"
                />
                <input
                  className="input"
                  value={ciudad}
                  onChange={(e) => setCiudad(e.target.value)}
                  placeholder="Ciudad"
                  maxLength={120}
                  aria-label="Ciudad"
                />
              </div>
              <input
                className="input"
                value={contacto}
                onChange={(e) => setContacto(e.target.value)}
                placeholder="Teléfono o correo"
                maxLength={200}
                aria-label="Teléfono o correo"
                data-testid="calculadora-contacto"
              />
              <button type="submit" className="btn-ghost w-full" disabled={calculando}>
                {calculando ? 'Enviando…' : 'Mándamelo'}
              </button>
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
