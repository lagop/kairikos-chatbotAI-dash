// =============================================================================
// Fase 5 — unit tests for lib/wizard-auto-approve.ts.
//
// Real catalogs module (pure, no I/O) so the tests exercise the actual
// `autoApprovableStepKeys` — ['3','4','5'] for chatbot, empty for every
// other product, which is itself the policy this feature exists to
// enforce. Prisma + wizard-review are mocked, same shape as every other
// sweep test this session (lead-classification-sweep.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  stepFindMany: vi.fn(),
  applySystemAutoApproval: vi.fn(),
  logError: vi.fn(),
}));

class MockWizardReviewError extends Error {
  constructor(public readonly error: { code: string }) {
    super(error.code);
    this.name = 'WizardReviewError';
  }
}

vi.mock('@/lib/wizard-review', () => ({
  applySystemAutoApproval: (...a: unknown[]) => mockState.applySystemAutoApproval(...a),
  WizardReviewError: MockWizardReviewError,
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const prismaMock = {
  chatbotConfigStep: { findMany: (...a: unknown[]) => mockState.stepFindMany(...a) },
} as never;

const NOW = new Date('2026-09-10T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockState.stepFindMany.mockResolvedValue([]);
  mockState.applySystemAutoApproval.mockResolvedValue({
    stepId: 'step_1',
    version: 2,
    activeForBot: true,
    approvedAt: NOW,
    deactivatedStepIds: [],
    transition: { nextState: null, notifyFired: false, resendMessageId: null, notifyError: null },
  });
});

async function sweep(now = NOW) {
  const { sweepAutoApprovableWizardSteps } = await import('@/lib/wizard-auto-approve');
  return sweepAutoApprovableWizardSteps(prismaMock, { now });
}

describe('computeAutoApproveDeadline', () => {
  it('is null for a step the catalog does not mark auto-approvable', async () => {
    const { computeAutoApproveDeadline } = await import('@/lib/wizard-auto-approve');
    expect(
      computeAutoApproveDeadline({ autoApprovable: false, status: 'submitted', submittedAt: NOW }),
    ).toBeNull();
  });

  it('is null while the step is not submitted', async () => {
    const { computeAutoApproveDeadline } = await import('@/lib/wizard-auto-approve');
    expect(computeAutoApproveDeadline({ autoApprovable: true, status: 'approved', submittedAt: NOW })).toBeNull();
    expect(computeAutoApproveDeadline({ autoApprovable: true, status: 'draft', submittedAt: null })).toBeNull();
  });

  it('is submittedAt + the veto window for a submitted, auto-approvable step', async () => {
    const { computeAutoApproveDeadline, AUTO_APPROVE_VETO_WINDOW_HOURS } = await import('@/lib/wizard-auto-approve');
    const deadline = computeAutoApproveDeadline({ autoApprovable: true, status: 'submitted', submittedAt: NOW });
    expect(deadline).toEqual(new Date(NOW.getTime() + AUTO_APPROVE_VETO_WINDOW_HOURS * 60 * 60 * 1000));
  });
});

describe('sweepAutoApprovableWizardSteps', () => {
  it('only ever queries the auto-approvable step keys, scoped to chatbot', async () => {
    await sweep();
    // Solo 'chatbot' tiene autoApprovableStepKeys no vacío hoy — el
    // barrido debe saltarse los otros seis productos sin ni siquiera
    // consultarlos.
    expect(mockState.stepFindMany).toHaveBeenCalledTimes(1);
    const call = mockState.stepFindMany.mock.calls[0][0];
    expect(call.where.productCode).toBe('chatbot');
    expect([...call.where.stepKey.in].sort()).toEqual(['3', '4', '5']);
    // Fase 4 multi-instancia — el grupo incluye el chatbot; ver el caso de
    // "dos chatbots" más abajo.
    expect(call.distinct).toEqual(['clientId', 'clientProductId', 'stepKey']);
    // Y el orderBy lleva el mismo prefijo: es lo que hace que el primero de
    // cada grupo sea la versión más alta.
    expect(call.orderBy.slice(0, 3)).toEqual([{ clientId: 'asc' }, { clientProductId: 'asc' }, { stepKey: 'asc' }]);
  });

  it('con dos chatbots del mismo cliente, aprueba el pendiente de CADA uno', async () => {
    // Antes se agrupaba por (cliente, paso) y un chatbot escondía al otro.
    mockState.stepFindMany.mockResolvedValue([
      { clientId: 'client_1', clientProductId: 'cp_a', stepKey: '5', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
      { clientId: 'client_1', clientProductId: 'cp_b', stepKey: '5', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
    ]);

    const result = await sweep();

    expect(result.approved).toBe(2);
    const approvedFor = mockState.applySystemAutoApproval.mock.calls.map((c) => c[1].clientProductId).sort();
    expect(approvedFor).toEqual(['cp_a', 'cp_b']);
  });

  it('approves a candidate past the veto window', async () => {
    mockState.stepFindMany.mockResolvedValue([
      { clientId: 'client_1', stepKey: '5', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
    ]);

    const result = await sweep();

    expect(result.candidatesScanned).toBe(1);
    expect(result.approved).toBe(1);
    expect(mockState.applySystemAutoApproval).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ clientId: 'client_1', productCode: 'chatbot', stepKey: '5' }),
    );
    // El motivo queda escrito, no es un genérico "system did something".
    const reason = mockState.applySystemAutoApproval.mock.calls[0][1].reason as string;
    expect(reason).toMatch(/veto/i);
    expect(reason).toMatch(/12h/);
  });

  it('leaves a step inside the veto window alone', async () => {
    mockState.stepFindMany.mockResolvedValue([
      // Enviado hace 1h — muy pronto para las 12h de ventana.
      { clientId: 'client_1', stepKey: '5', status: 'submitted', submittedAt: new Date('2026-09-10T11:00:00.000Z') },
    ]);

    const result = await sweep();

    expect(result.candidatesScanned).toBe(0);
    expect(result.approved).toBe(0);
    expect(mockState.applySystemAutoApproval).not.toHaveBeenCalled();
  });

  it('never asks the database for a step outside the auto-approvable set', async () => {
    await sweep();
    // 'Cumplimiento' (10) y 'Personalidad y límites' (2) — donde sí hay
    // algo que un operador tiene que juzgar — nunca entran en el filtro
    // que la query manda a Postgres, así que ni una fila suya puede
    // llegar jamás a la rama que aprueba.
    const inClause: string[] = mockState.stepFindMany.mock.calls[0][0].where.stepKey.in;
    expect(inClause).not.toContain('10');
    expect(inClause).not.toContain('2');
  });

  it('treats a race (operator or client acted first) as a skip, not a failure', async () => {
    mockState.stepFindMany.mockResolvedValue([
      { clientId: 'client_1', stepKey: '3', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
      { clientId: 'client_2', stepKey: '4', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
    ]);
    mockState.applySystemAutoApproval
      .mockRejectedValueOnce(new MockWizardReviewError({ code: 'invalid_state_for_approve' }))
      .mockResolvedValueOnce({
        stepId: 's2',
        version: 1,
        activeForBot: true,
        approvedAt: NOW,
        deactivatedStepIds: [],
        transition: { nextState: null, notifyFired: false, resendMessageId: null, notifyError: null },
      });

    const result = await sweep();

    expect(result.candidatesScanned).toBe(2);
    expect(result.skippedRace).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('isolates a genuine failure so the rest of the sweep keeps going', async () => {
    mockState.stepFindMany.mockResolvedValue([
      { clientId: 'client_1', stepKey: '3', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
      { clientId: 'client_2', stepKey: '4', status: 'submitted', submittedAt: new Date('2026-09-09T00:00:00.000Z') },
    ]);
    mockState.applySystemAutoApproval
      .mockRejectedValueOnce(new Error('db exploded'))
      .mockResolvedValueOnce({
        stepId: 's2',
        version: 1,
        activeForBot: true,
        approvedAt: NOW,
        deactivatedStepIds: [],
        transition: { nextState: null, notifyFired: false, resendMessageId: null, notifyError: null },
      });

    const result = await sweep();

    expect(result.approved).toBe(1);
    expect(result.failed).toEqual([
      { clientId: 'client_1', productCode: 'chatbot', stepKey: '3', error: 'db exploded' },
    ]);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('isolates a query failure to its own product and keeps scanning', async () => {
    // Hoy solo 'chatbot' tiene claves auto-aprobables, así que esto
    // ejercita el único try/catch de consulta que existe — documenta el
    // contrato para cuando WP-16 dé a un segundo producto su catálogo.
    mockState.stepFindMany.mockRejectedValueOnce(new Error('connection reset'));
    const result = await sweep();
    expect(result.failed).toEqual([{ clientId: null, productCode: 'chatbot', stepKey: null, error: 'connection reset' }]);
    expect(result.approved).toBe(0);
  });

  it('never throws', async () => {
    mockState.stepFindMany.mockRejectedValue(new Error('total outage'));
    await expect(sweep()).resolves.toBeDefined();
  });
});
