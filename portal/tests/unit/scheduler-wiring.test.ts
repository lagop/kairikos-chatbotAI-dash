// =============================================================================
// El guardia de la trampa nº1 de CLAUDE.md.
//
// "Un cron nuevo no corre si no se añade a scripts/scheduler.sh". Es la
// causa habitual de "lo implementé y no pasa nada", y no da error: la ruta
// existe, responde perfectamente si la llamas a mano, y simplemente nadie
// la llama nunca. vercel.json declara horarios pero es INERTE — este stack
// no está en Vercel, y el único disparador real es el bucle de
// scheduler.sh.
//
// Ningún test vigilaba esto hasta ahora, que es justo por lo que la trampa
// se documentó: a un fallo silencioso solo lo caza algo que mire la
// estructura, porque el comportamiento es indistinguible del correcto.
//
// Se añadió al construir /api/cron/recovery-tick (Fase 3): si vas a
// acordarte tú de la lista, mejor que se acuerde la suite.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CRON_DIR = join(process.cwd(), 'src/app/api/cron');
const SCHEDULER = join(process.cwd(), '../scripts/scheduler.sh');

/**
 * Rutas de cron que NO van en el bucle del scheduler, con su motivo.
 *
 * Vacío hoy. Cuando haga falta una excepción —una ruta que dispara otro
 * sistema, o una que solo se llama a mano— va aquí con su porqué, no se
 * borra el test.
 */
const DELIBERATELY_UNSCHEDULED: Record<string, string> = {};

describe('todas las rutas de cron están en scheduler.sh', () => {
  const routes = readdirSync(CRON_DIR).filter((name) =>
    existsSync(join(CRON_DIR, name, 'route.ts')),
  );

  const scheduler = readFileSync(SCHEDULER, 'utf8');
  const scheduled = new Set(
    (scheduler.match(/\/api\/cron\/[a-z0-9-]+/g) ?? []).map((p) => p.replace('/api/cron/', '')),
  );

  // El guardia del guardia: si algún día cambia la estructura de
  // carpetas o el formato de la lista, esto falla en vez de pasar en
  // verde sin comprobar nada.
  it('encuentra rutas y encuentra la lista', () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(scheduled.size).toBeGreaterThan(5);
  });

  it('ninguna ruta de cron se queda fuera del bucle que de verdad las dispara', () => {
    const missing = routes.filter((r) => !scheduled.has(r) && !(r in DELIBERATELY_UNSCHEDULED));
    expect(
      missing,
      `Estas rutas de cron NO se ejecutarán nunca en la VPS:\n  ${missing.join('\n  ')}\n\n` +
        'Añádelas a ENDPOINTS en scripts/scheduler.sh. vercel.json no sirve: es inerte ' +
        'en este stack (ver CLAUDE.md, trampa nº1).',
    ).toEqual([]);
  });

  it('el scheduler no llama a rutas que ya no existen', () => {
    // El fallo simétrico, y más silencioso todavía: el bucle pide una ruta
    // borrada, recibe 404, lo registra como FAILED y sigue. Nadie mira ese
    // log hasta que hay otro problema.
    const orphans = [...scheduled].filter((s) => !routes.includes(s));
    expect(orphans, `El scheduler llama a rutas que no existen:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });
});
