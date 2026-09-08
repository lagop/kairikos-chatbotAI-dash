// =============================================================================
// Fase 2.2 — unit tests para src/lib/review-alerts.ts.
//
// Lo que hay que proteger aquí es sobre todo lo que NO debe pasar: que
// activar la función mande una avalancha de correos por reseñas viejas, y
// que un mismo review avise dos veces.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({ send: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  shouldAlertForReview,
  buildNegativeReviewEmail,
  sweepNegativeReviewAlerts,
  NEGATIVE_ALERT_MAX_AGE_DAYS,
  NEGATIVE_STAR_THRESHOLD,
} from '@/lib/review-alerts';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

const prismaState = {
  reviewFindMany: vi.fn(),
  reviewUpdate: vi.fn(),
  clientFindUnique: vi.fn(),
};

const prismaMock = {
  googleReview: {
    findMany: (...a: unknown[]) => prismaState.reviewFindMany(...a),
    update: (...a: unknown[]) => prismaState.reviewUpdate(...a),
  },
  chatbotClient: { findUnique: (...a: unknown[]) => prismaState.clientFindUnique(...a) },
} as unknown as Parameters<typeof sweepNegativeReviewAlerts>[0];

function negativeReview(over: Record<string, unknown> = {}) {
  return {
    id: 'rev_1',
    reviewerName: 'Marta',
    starRating: 1,
    comment: 'Esperé cuarenta minutos.',
    createTime: daysAgo(1),
    ...over,
  };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test_key';
  prismaState.reviewFindMany.mockReset().mockResolvedValue([]);
  prismaState.reviewUpdate.mockReset().mockResolvedValue({});
  prismaState.clientFindUnique.mockReset().mockResolvedValue({
    email: 'aurora@example.com', name: 'Aurora', companyName: 'Peluquería Aurora',
  });
  mockState.logError.mockReset();
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe('shouldAlertForReview', () => {
  it('avisa de una reseña reciente', () => {
    expect(shouldAlertForReview(daysAgo(1), NOW)).toBe(true);
  });

  it('no avisa de una del histórico — no es una noticia', () => {
    expect(shouldAlertForReview(daysAgo(NEGATIVE_ALERT_MAX_AGE_DAYS + 1), NOW)).toBe(false);
    expect(shouldAlertForReview(daysAgo(240), NOW)).toBe(false);
  });
});

describe('buildNegativeReviewEmail', () => {
  it('dice quién, cuántas estrellas y qué escribió', () => {
    const mail = buildNegativeReviewEmail({
      businessName: 'Peluquería Aurora', reviewerName: 'Marta', starRating: 1, comment: 'Esperé mucho.',
    });
    expect(mail.subject).toContain('1 estrella');
    expect(mail.text).toContain('Marta');
    expect(mail.text).toContain('Esperé mucho.');
    expect(mail.html).toContain('Peluquería Aurora');
  });

  it('funciona sin nombre y sin comentario', () => {
    const mail = buildNegativeReviewEmail({
      businessName: 'X', reviewerName: null, starRating: 2, comment: null,
    });
    expect(mail.subject).toContain('2 estrellas');
    expect(mail.text).toContain('Alguien');
  });

  it('escapa el HTML de lo que escribió un desconocido', () => {
    const mail = buildNegativeReviewEmail({
      businessName: 'X', reviewerName: '<script>alert(1)</script>', starRating: 1, comment: null,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});

describe('sweepNegativeReviewAlerts', () => {
  it('busca solo negativas sin avisar', async () => {
    await sweepNegativeReviewAlerts(prismaMock, 'c1', NOW);
    expect(prismaState.reviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'c1', starRating: { lte: NEGATIVE_STAR_THRESHOLD }, negativeAlertSentAt: null },
      }),
    );
  });

  it('sin negativas pendientes, ni siquiera consulta el cliente', async () => {
    const result = await sweepNegativeReviewAlerts(prismaMock, 'c1', NOW);
    expect(result).toEqual({ found: 0, alerted: 0, suppressedOld: 0 });
    expect(prismaState.clientFindUnique).not.toHaveBeenCalled();
  });

  it('marca el histórico como avisado SIN enviar nada', async () => {
    prismaState.reviewFindMany.mockResolvedValue([negativeReview({ createTime: daysAgo(200) })]);

    const result = await sweepNegativeReviewAlerts(prismaMock, 'c1', NOW);

    expect(result).toEqual({ found: 1, alerted: 0, suppressedOld: 1 });
    // Sellada igualmente: no volverá a mirarse nunca más.
    expect(prismaState.reviewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rev_1' }, data: { negativeAlertSentAt: NOW } }),
    );
  });

  it('sin RESEND_API_KEY no falla: la marca igualmente como tratada', async () => {
    delete process.env.RESEND_API_KEY;
    prismaState.reviewFindMany.mockResolvedValue([negativeReview()]);

    const result = await sweepNegativeReviewAlerts(prismaMock, 'c1', NOW);

    expect(result.found).toBe(1);
    expect(prismaState.reviewUpdate).toHaveBeenCalled();
    expect(mockState.logError).not.toHaveBeenCalled();
  });

  it('un cliente sin email no rompe el barrido', async () => {
    prismaState.clientFindUnique.mockResolvedValue({ email: '', name: 'X', companyName: null });
    prismaState.reviewFindMany.mockResolvedValue([negativeReview()]);

    const result = await sweepNegativeReviewAlerts(prismaMock, 'c1', NOW);

    expect(result.found).toBe(1);
    expect(prismaState.reviewUpdate).toHaveBeenCalled();
  });
});
