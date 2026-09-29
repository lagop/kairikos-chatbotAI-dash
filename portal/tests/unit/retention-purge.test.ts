// =============================================================================
// El borrado por plazo de conservación (src/lib/retention-purge.ts).
//
// Lo que estos tests guardan son las dos maneras de fallar que no hacen ruido:
//   - borrar de más: leads de la prospección de un CLIENTE, que no son
//     nuestros, o un prospecto que se opuso, que tras borrarse volvería a
//     entrar como nuevo y recibiría otro mensaje;
//   - borrar de menos: una condición que nunca casa y deja la política
//     publicada sin cumplir, con la ruta respondiendo 200 igual.
// Prisma va mockeado: la forma de las consultas se comprueba aquí y contra el
// Postgres real a mano (ver el PR).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  runRetentionPurge,
  retentionCutoff,
  LEAD_BATCH_LIMIT,
  RETENTION_ACTOR_ID,
} from '@/lib/retention-purge';

const calls: string[] = [];
const fn = (name: string, value: unknown = { count: 0 }) =>
  vi.fn((..._args: unknown[]) => {
    calls.push(name);
    return value;
  });

const m = {
  calculatorLead: { deleteMany: fn('calculatorLead.deleteMany', { count: 2 }) },
  publicDraftRequest: { deleteMany: fn('publicDraftRequest.deleteMany', { count: 1 }) },
  lead: {
    findMany: vi.fn(),
    updateMany: fn('lead.updateMany'),
    deleteMany: fn('lead.deleteMany'),
  },
  leadAudit: { createMany: fn('leadAudit.createMany'), deleteMany: fn('leadAudit.deleteMany') },
  prospectingCompetitorSnapshot: { deleteMany: fn('snapshot.deleteMany') },
  prospectingWebDraft: { deleteMany: fn('webDraft.deleteMany') },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
};
const prisma = m as unknown as PrismaClient;

const NOW = new Date('2029-10-01T12:00:00.000Z');
const THREE_YEARS_AGO = new Date('2026-10-01T12:00:00.000Z');

type Where = Record<string, unknown>;
const findManyWheres = () => m.lead.findMany.mock.calls.map((c) => (c[0] as { where: Where }).where);
/** El where de la búsqueda de oposición y el de la de plazo, por su contenido. */
const minimizeWhere = () => findManyWheres().find((w) => JSON.stringify(w).includes('optedOutAt') && !JSON.stringify(w).includes('NOT'))!;
const expireWhere = () => findManyWheres().find((w) => JSON.stringify(w).includes('NOT'))!;

beforeEach(() => {
  calls.length = 0;
  for (const group of Object.values(m)) {
    if (typeof group === 'function') continue;
    for (const f of Object.values(group)) (f as ReturnType<typeof vi.fn>).mockClear();
  }
  m.$transaction.mockClear();
  m.lead.findMany.mockReset().mockResolvedValue([]);
});

describe('retentionCutoff', () => {
  it('cuenta años de calendario: el mismo día, tres años antes', () => {
    expect(retentionCutoff(NOW, 3).toISOString()).toBe(THREE_YEARS_AGO.toISOString());
  });

  it('no muta la fecha que recibe', () => {
    const now = new Date(NOW);
    retentionCutoff(now, 3);
    expect(now.toISOString()).toBe(NOW.toISOString());
  });
});

describe('herramientas gratuitas', () => {
  it('borra la calculadora y el borrador de web por el último contacto, no por el alta', async () => {
    const result = await runRetentionPurge(prisma, NOW);

    for (const del of [m.calculatorLead.deleteMany, m.publicDraftRequest.deleteMany]) {
      const where = (del.mock.calls[0][0] as { where: Where }).where;
      expect(where.createdAt).toEqual({ lt: THREE_YEARS_AGO });
      // Un contacto reciente reinicia el plazo: contactedAt también tiene que
      // haber vencido, o no existir.
      expect(where.OR).toEqual([{ contactedAt: null }, { contactedAt: { lt: THREE_YEARS_AGO } }]);
    }
    expect(result.calculatorLeadsDeleted).toBe(2);
    expect(result.draftRequestsDeleted).toBe(1);
  });
});

describe('prospección propia', () => {
  it('solo toca leads outbound de cuentas internas: los de un cliente son del cliente', async () => {
    await runRetentionPurge(prisma, NOW);
    expect(m.lead.findMany).toHaveBeenCalledTimes(2);
    for (const where of findManyWheres()) {
      expect((where.AND as Where[])[0]).toEqual({ source: 'outbound', client: { isInternal: true } });
    }
  });

  it('borra a los tres años desde que se obtuvo, salvo a quien se opuso', async () => {
    await runRetentionPurge(prisma, NOW);
    const and = expireWhere().AND as Where[];
    expect(and).toContainEqual({ createdAt: { lt: THREE_YEARS_AGO } });
    expect(and).toContainEqual({ NOT: { optedOutAt: { not: null } } });
  });

  it('minimiza al que se opuso, sin esperar al plazo', async () => {
    await runRetentionPurge(prisma, NOW);
    const and = minimizeWhere().AND as Where[];
    expect(and).toContainEqual({ optedOutAt: { not: null } });
    expect(JSON.stringify(and)).not.toContain('createdAt');
  });

  it('al minimizar conserva el teléfono y el id de Google, que son los que impiden volver a escribirle', async () => {
    m.lead.findMany.mockImplementation(async (arg: { where: Where }) =>
      JSON.stringify(arg.where).includes('NOT')
        ? []
        : [{ id: 'l1', clientId: 'c1', tenantId: null, status: 'descartado' }],
    );

    const result = await runRetentionPurge(prisma, NOW);

    const data = (m.lead.updateMany.mock.calls[0][0] as { data: Where }).data;
    expect(data).not.toHaveProperty('contactPhone');
    expect(data).not.toHaveProperty('externalPlaceId');
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('repliedAt');
    expect(data).not.toHaveProperty('optedOutAt');
    expect(data).toMatchObject({ contactName: null, contactEmail: null, website: null, summary: null });
    expect(m.prospectingCompetitorSnapshot.deleteMany).toHaveBeenCalledWith({ where: { leadId: { in: ['l1'] } } });
    expect(m.prospectingWebDraft.deleteMany).toHaveBeenCalledWith({ where: { leadId: { in: ['l1'] } } });
    expect(m.lead.deleteMany).not.toHaveBeenCalled();

    const audit = (m.leadAudit.createMany.mock.calls[0][0] as { data: Where[] }).data[0];
    expect(audit).toMatchObject({ leadId: 'l1', action: 'minimized_opposition', actorId: RETENTION_ACTOR_ID });
    expect(result.ownProspectsMinimized).toBe(1);
  });

  it('la minimización es idempotente: solo busca los que aún tienen algo que vaciar', async () => {
    await runRetentionPurge(prisma, NOW);
    const notYet = (minimizeWhere().AND as Where[])[2] as { OR: Where[] };
    expect(notYet.OR).toContainEqual({ contactName: { not: null } });
    expect(notYet.OR).toContainEqual({ webDraft: { isNot: null } });
    expect(notYet.OR).toContainEqual({ competitorSnapshot: { isNot: null } });
  });

  it('al borrar, el rastro de auditoría se va antes que el lead y en la misma transacción', async () => {
    m.lead.findMany.mockImplementation(async (arg: { where: Where }) =>
      JSON.stringify(arg.where).includes('NOT') ? [{ id: 'old1' }, { id: 'old2' }] : [],
    );

    const result = await runRetentionPurge(prisma, NOW);

    expect(calls.indexOf('leadAudit.deleteMany')).toBeLessThan(calls.indexOf('lead.deleteMany'));
    expect(m.leadAudit.deleteMany).toHaveBeenCalledWith({ where: { leadId: { in: ['old1', 'old2'] } } });
    expect(m.lead.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old1', 'old2'] } } });
    expect(result.ownProspectsDeleted).toBe(2);
  });

  it('va acotado y empieza por los más antiguos', async () => {
    await runRetentionPurge(prisma, NOW);
    for (const call of m.lead.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ take: LEAD_BATCH_LIMIT, orderBy: { createdAt: 'asc' } });
    }
  });

  it('sin nada que hacer no escribe nada en los leads', async () => {
    const result = await runRetentionPurge(prisma, NOW);
    expect(m.lead.updateMany).not.toHaveBeenCalled();
    expect(m.lead.deleteMany).not.toHaveBeenCalled();
    expect(m.leadAudit.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ownProspectsDeleted: 0, ownProspectsMinimized: 0 });
  });
});
