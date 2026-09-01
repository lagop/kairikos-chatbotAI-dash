import { CLAVES_DE_CIFRADO, estadoDeClave, type EstadoDeClave } from '@/lib/claves-de-cifrado';

// =============================================================================
// Panel de solo lectura: ¿está cada clave de cifrado en el contenedor?
// Deliberadamente NO editable desde aquí — ver lib/claves-de-cifrado.ts: una
// clave que protege secretos en Postgres no puede vivir en ese mismo
// Postgres. Este panel solo ahorra al operador entrar por SSH para ver cuál
// falta. Componente de servidor: lee process.env al renderizar, y el valor
// nunca sale de aquí; solo su estado.
// =============================================================================

const ESTADO: Record<EstadoDeClave, { texto: string; clase: string }> = {
  configurada: { texto: 'Configurada', clase: 'text-kairikos-success' },
  falta: { texto: 'Falta', clase: 'text-kairikos-danger' },
  formato_invalido: { texto: 'Formato inválido', clase: 'text-kairikos-danger' },
};

export function EncryptionKeyStatusTable() {
  return (
    <section className="card space-y-4" aria-label="Claves de cifrado" data-testid="encryption-key-status">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Claves de cifrado</h2>
        <p className="text-sm text-kairikos-muted">
          Solo lectura. Cada clave protege secretos guardados en Postgres, así que vive únicamente en el entorno del
          servidor, nunca en la base de datos.
        </p>
        {/* Las dos advertencias son de fallos reales: el .env de la VPS
            se reescribe entero en cada despliegue (CLAUDE.md, trampa 2), y
            una clave nueva no abre lo que se cifró con la anterior. */}
        <p className="text-sm text-kairikos-muted">
          Para añadir una que falte: créala como secreto del repositorio (<code>openssl rand -hex 32</code>) y
          despliega. Ponerla a mano en la VPS no sirve: el siguiente despliegue la borra.
        </p>
        <p className="text-sm text-kairikos-muted">
          Nunca cambies una clave que ya está configurada: lo que se cifró con ella dejaría de poder leerse.
        </p>
      </div>
      <ul className="divide-y divide-kairikos-border">
        {CLAVES_DE_CIFRADO.map((clave) => {
          const estado = ESTADO[estadoDeClave(process.env[clave.nombre])];
          return (
            <li
              key={clave.nombre}
              className="flex items-center justify-between gap-4 py-2.5"
              data-testid={`encryption-key-${clave.nombre}`}
            >
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{clave.nombre}</p>
                <p className="text-xs text-kairikos-muted">{clave.protege}</p>
              </div>
              <span
                className={`shrink-0 text-sm font-medium ${estado.clase}`}
                data-testid={`encryption-key-${clave.nombre}-status`}
              >
                {estado.texto}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
