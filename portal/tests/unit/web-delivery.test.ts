// =============================================================================
// Fase 3 — unit tests para src/lib/web-delivery.ts.
//
// Lo que se fija:
//
//   • Que el catálogo mande sobre lo guardado. De eso depende que añadir
//     una etapa nueva no exija migrar los proyectos en curso, y que una
//     fila de una etapa retirada no dibuje un paso fantasma.
//   • Que las fechas no se reescriban. Un operador que vuelve a pulsar el
//     mismo botón no puede mover una fecha que el cliente ya ha visto.
//   • Que el seguimiento no se encienda antes de que haya dinero.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  WEB_MILESTONES,
  MILESTONE_KEYS,
  buildDeliveryProgress,
  hasDeliveryTracking,
  isMilestoneKey,
  setMilestone,
} from '@/lib/web-delivery';

describe('el catálogo de etapas', () => {
  it('son cinco, en orden, y todas con texto para el cliente', () => {
    expect(MILESTONE_KEYS).toEqual(['brief', 'design', 'build', 'review', 'launch']);
    for (const m of WEB_MILESTONES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.detail.length).toBeGreaterThan(0);
    }
  });

  it('reconoce solo las etapas del catálogo', () => {
    expect(isMilestoneKey('design')).toBe(true);
    expect(isMilestoneKey('deploy')).toBe(false);
    expect(isMilestoneKey('')).toBe(false);
  });
});

describe('hasDeliveryTracking', () => {
  it('se enciende cuando hay dinero encima de la mesa', () => {
    for (const status of ['deposit_paid', 'invoiced_final', 'paid']) {
      expect(hasDeliveryTracking(status)).toBe(true);
    }
  });

  it('no antes: enseñar etapas de un presupuesto sin aceptar promete un trabajo no encargado', () => {
    for (const status of ['draft', 'sent', 'accepted', 'invoiced', 'cancelled']) {
      expect(hasDeliveryTracking(status)).toBe(false);
    }
  });
});

describe('buildDeliveryProgress', () => {
  it('sin ninguna fila, todas las etapas salen pendientes', () => {
    const progress = buildDeliveryProgress([]);
    expect(progress.total).toBe(5);
    expect(progress.done).toBe(0);
    expect(progress.current).toBeNull();
    expect(progress.milestones.every((m) => m.status === 'pending')).toBe(true);
  });

  it('respeta el orden del catálogo, no el de las filas', () => {
    const progress = buildDeliveryProgress([
      { key: 'launch', status: 'pending', startedAt: null, completedAt: null, note: null },
      { key: 'brief', status: 'done', startedAt: null, completedAt: null, note: null },
    ]);
    expect(progress.milestones.map((m) => m.key)).toEqual(MILESTONE_KEYS);
  });

  it('cuenta las terminadas y encuentra la que está en marcha', () => {
    const progress = buildDeliveryProgress([
      { key: 'brief', status: 'done', startedAt: null, completedAt: null, note: null },
      { key: 'design', status: 'done', startedAt: null, completedAt: null, note: null },
      { key: 'build', status: 'in_progress', startedAt: null, completedAt: null, note: 'esperando tus fotos' },
    ]);
    expect(progress.done).toBe(2);
    expect(progress.current).toMatchObject({ key: 'build', note: 'esperando tus fotos' });
  });

  it('una fila de una etapa retirada del catálogo se ignora', () => {
    const progress = buildDeliveryProgress([
      { key: 'etapa_que_ya_no_existe', status: 'done', startedAt: null, completedAt: null, note: null },
    ]);
    expect(progress.milestones).toHaveLength(5);
    expect(progress.done).toBe(0);
  });

  it('un estado corrupto se lee como pendiente, no rompe la pantalla', () => {
    const progress = buildDeliveryProgress([
      { key: 'brief', status: 'vaya', startedAt: null, completedAt: null, note: null },
    ]);
    expect(progress.milestones[0].status).toBe('pending');
  });
});

describe('setMilestone', () => {
  const state = { findUnique: vi.fn(), upsert: vi.fn(), auditCreate: vi.fn() };
  const tx = {
    webProjectMilestone: { upsert: (...a: unknown[]) => state.upsert(...a) },
    webQuoteAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    webProjectMilestone: { findUnique: (...a: unknown[]) => state.findUnique(...a) },
  } as unknown as PrismaClient;

  const NOW = new Date('2026-09-20T10:00:00Z');
  const base = {
    webQuoteId: 'wq_1',
    clientId: 'c1',
    tenantId: 't1',
    key: 'design',
    actorId: 'op_1',
    actorType: 'operator' as const,
    now: NOW,
  };

  beforeEach(() => {
    for (const fn of Object.values(state)) fn.mockReset();
    state.findUnique.mockResolvedValue(null);
    state.upsert.mockResolvedValue({});
    state.auditCreate.mockResolvedValue({});
  });

  it('rechaza una etapa que no está en el catálogo, sin tocar la base de datos', async () => {
    expect(await setMilestone(prisma, { ...base, key: 'deploy', status: 'done' })).toEqual({
      ok: false,
      error: 'unknown_milestone',
    });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('estampa el inicio al ponerla en marcha', async () => {
    await setMilestone(prisma, { ...base, status: 'in_progress' });
    expect(state.upsert.mock.calls[0][0].create).toMatchObject({
      status: 'in_progress',
      startedAt: NOW,
      completedAt: null,
    });
  });

  it('al terminarla estampa las dos fechas si no había empezado', async () => {
    await setMilestone(prisma, { ...base, status: 'done' });
    expect(state.upsert.mock.calls[0][0].create).toMatchObject({ startedAt: NOW, completedAt: NOW });
  });

  it('NO reescribe una fecha que el cliente ya ha visto', async () => {
    const started = new Date('2026-09-10T08:00:00Z');
    state.findUnique.mockResolvedValue({ startedAt: started, completedAt: null });

    await setMilestone(prisma, { ...base, status: 'done' });

    const update = state.upsert.mock.calls[0][0].update;
    expect(update.startedAt).toEqual(started);
    expect(update.completedAt).toEqual(NOW);
  });

  it('deja rastro en la auditoría del presupuesto, con quién lo movió', async () => {
    await setMilestone(prisma, { ...base, status: 'done' });
    expect(state.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webQuoteId: 'wq_1',
        action: 'milestone_updated',
        actorType: 'operator',
        actorOperatorId: 'op_1',
        after: { key: 'design', status: 'done' },
      }),
    });
  });

  it('una nota sin tocar no borra la que ya había', async () => {
    state.findUnique.mockResolvedValue({ startedAt: null, completedAt: null });
    await setMilestone(prisma, { ...base, status: 'done' });
    expect(state.upsert.mock.calls[0][0].update).not.toHaveProperty('note');

    state.upsert.mockClear();
    await setMilestone(prisma, { ...base, status: 'done', note: null });
    expect(state.upsert.mock.calls[0][0].update).toHaveProperty('note', null);
  });
});
