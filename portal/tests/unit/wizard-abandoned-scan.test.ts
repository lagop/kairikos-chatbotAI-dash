// Escaneo de asistentes abandonados (POST /api/internal/wizard-abandoned/scan).
//
// La consulta es SQL crudo: Prisma no la comprueba contra el esquema y un
// nombre de columna mal escrito solo falla en producción. Pasó con
// `c.vertical`, que «ChatbotClient» nunca tuvo: el escaneo falló desde junio
// hasta noviembre de 2026 sin que ningún test lo viera. Aquí se captura el SQL
// que manda la ruta y se comprueba cada columna contra el modelo de Prisma.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const queryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
  isDatabaseConfigured: true,
}));
vi.mock('@/lib/internal-auth', () => ({
  authenticateInternalRequest: () => ({ ok: true }),
  internalAuthFailureResponse: () => null,
}));

import { POST } from '@/app/api/internal/wizard-abandoned/scan/route';

function columnsOf(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`modelo ${model} no encontrado`);
  return new Set(m.fields.filter((f) => f.kind === 'scalar').map((f) => f.dbName ?? f.name));
}

/** Columnas `alias.col` o `alias."col"` dentro de un trozo de SQL. */
function referenced(sql: string, alias: string): string[] {
  const re = new RegExp(`\\b${alias}\\.(?:"([^"]+)"|([a-z_][A-Za-z0-9_]*))`, 'g');
  return [...sql.matchAll(re)].map((m) => m[1] ?? m[2]);
}

async function runScan(rows: unknown[] = []) {
  queryRaw.mockResolvedValueOnce(rows);
  const res = await POST(new Request('http://portal.test/api/internal/wizard-abandoned/scan', { method: 'POST', body: '{}' }) as never);
  const sql = (queryRaw.mock.calls.at(-1)?.[0] as Prisma.Sql).sql;
  return { res, sql };
}

describe('wizard-abandoned scan', () => {
  beforeEach(() => queryRaw.mockReset());

  it('solo pide columnas que existen en el esquema', async () => {
    const { res, sql } = await runScan();
    expect(res.status).toBe(200);

    // `c` es «ChatbotClient» solo dentro del CTE configuring_clients; en el
    // SELECT final es el CTE y sus columnas son los alias entre comillas.
    const cte = sql.slice(sql.indexOf('configuring_clients AS ('), sql.indexOf('last_draft AS ('));
    expect(cte).toContain('FROM "ChatbotClient" c');
    const checks: Array<[string, string, string]> = [
      [cte, 'c', 'ChatbotClient'],
      [sql, 's', 'ChatbotConfigStep'],
      [sql, 'a', 'ChatbotActivity'],
    ];
    for (const [text, alias, model] of checks) {
      const cols = referenced(text, alias);
      expect(cols.length, `${alias} → ${model}`).toBeGreaterThan(0);
      const known = columnsOf(model);
      expect(cols.filter((c) => !known.has(c)), `${alias} → ${model}`).toEqual([]);
    }
  });

  it('devuelve los candidatos sin vertical, con fechas ISO y horas redondeadas', async () => {
    const { res } = await runScan([
      {
        clientId: 'cli_1',
        clientProductId: 'cp_1',
        companyName: 'Clínica Ejemplo',
        contactEmail: 'hola@ejemplo.test',
        contactName: 'Ana',
        tier: 'starter',
        lastDraftAt: '2026-11-10T08:00:00.000Z',
        lastSubmittedAt: null,
        lastStepKey: 'step3',
        hoursSinceLastDraft: '61.23456',
        alreadyFiredInWindow: false,
      },
    ]);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.candidates).toEqual([
      {
        clientId: 'cli_1',
        clientProductId: 'cp_1',
        companyName: 'Clínica Ejemplo',
        contactEmail: 'hola@ejemplo.test',
        contactName: 'Ana',
        tier: 'starter',
        lastDraftAt: '2026-11-10T08:00:00.000Z',
        lastSubmittedAt: null,
        lastStepKey: 'step3',
        hoursSinceLastDraft: 61.23,
        alreadyFiredInWindow: false,
      },
    ]);
  });
});
