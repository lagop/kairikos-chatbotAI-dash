// =============================================================================
// Fase 3 — tests del motor de disparadores.
//
// El peso está donde está el riesgo: en las EXCLUSIONES. Un disparador que
// se olvida de un candidato cuesta un mensaje no enviado. Un disparador
// que se salta una exclusión cuesta un mensaje enviado a quien pidió la
// baja, que es un problema de otra categoría.
//
// Por eso hay un bloque entero comprobando que no existe forma de obtener
// candidatos sin filtrar, y no solo que el filtro funciona.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  exclusionFor,
  findRecoveryCandidates,
  RECENT_CONTACT_DAYS,
  MAX_LEGAL_BASIS_MONTHS,
  type ExclusionContext,
} from '@/lib/recovery-triggers';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const monthsAgo = (n: number) => {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - n);
  return d;
};

/** Un contacto al que SÍ se le puede escribir. Cada test rompe una cosa. */
const CLEAN: ExclusionContext = {
  legalBasis: 'inbound_contact',
  legalBasisCapturedAt: monthsAgo(3),
  isSuppressed: false,
  lastContactedAt: daysAgo(90),
  hasScheduledCallback: false,
  now: NOW,
};

describe('exclusionFor', () => {
  it('deja pasar a un contacto con base legal reciente, sin baja y sin trato reciente', () => {
    expect(exclusionFor(CLEAN)).toBeNull();
  });

  it('excluye a quien pidió la baja', () => {
    expect(exclusionFor({ ...CLEAN, isSuppressed: true })).toBe('suppressed');
  });

  it('excluye a quien nunca recibió el aviso de oposición', () => {
    expect(exclusionFor({ ...CLEAN, legalBasis: null })).toBe('no_legal_basis');
  });

  it('excluye a quien lo recibió hace demasiado', () => {
    expect(
      exclusionFor({ ...CLEAN, legalBasisCapturedAt: monthsAgo(MAX_LEGAL_BASIS_MONTHS + 1) }),
    ).toBe('legal_basis_stale');
  });

  it('trata una base legal sin fecha como caducada, no como válida', () => {
    // Un contacto con base y sin fecha es un dato roto, y ante un dato
    // roto la respuesta segura es no escribirle.
    expect(exclusionFor({ ...CLEAN, legalBasisCapturedAt: null })).toBe('legal_basis_stale');
  });

  it('excluye a quien ya tiene una devolución de llamada agendada — escribirle ahora es interrumpir', () => {
    expect(exclusionFor({ ...CLEAN, hasScheduledCallback: true })).toBe('callback_scheduled');
  });

  it('excluye a quien recibió un mensaje dentro de la ventana de descanso', () => {
    expect(exclusionFor({ ...CLEAN, lastContactedAt: daysAgo(RECENT_CONTACT_DAYS - 1) })).toBe(
      'contacted_recently',
    );
  });

  it('deja pasar a quien lo recibió justo fuera de la ventana', () => {
    expect(exclusionFor({ ...CLEAN, lastContactedAt: daysAgo(RECENT_CONTACT_DAYS + 1) })).toBeNull();
  });

  it('deja pasar a quien nunca ha recibido nada', () => {
    expect(exclusionFor({ ...CLEAN, lastContactedAt: null })).toBeNull();
  });

  // EL ORDEN IMPORTA: si alguien pregunta "¿por qué no le escribisteis?",
  // la respuesta tiene que ser "porque se dio de baja", no "porque le
  // habíamos escrito hace poco".
  it('ante varios motivos devuelve el MÁS GRAVE, no el primero que aparezca', () => {
    expect(
      exclusionFor({
        ...CLEAN,
        isSuppressed: true,
        legalBasis: null,
        lastContactedAt: daysAgo(1),
        hasScheduledCallback: true,
      }),
    ).toBe('suppressed');
  });

  it('sin baja, la falta de base legal manda sobre el trato reciente', () => {
    expect(exclusionFor({ ...CLEAN, legalBasis: null, lastContactedAt: daysAgo(1) })).toBe(
      'no_legal_basis',
    );
  });
});

// ---------------------------------------------------------------------------

const state = {
  serviceQuoteFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  contactFindMany: vi.fn(),
  blockedFindMany: vi.fn(),
  outboundFindMany: vi.fn(),
  callEventFindMany: vi.fn(),
};

const prisma = {
  serviceQuote: { findMany: (...a: unknown[]) => state.serviceQuoteFindMany(...a) },
  job: { findMany: (...a: unknown[]) => state.jobFindMany(...a) },
  contact: { findMany: (...a: unknown[]) => state.contactFindMany(...a) },
  recallBlockedNumber: { findMany: (...a: unknown[]) => state.blockedFindMany(...a) },
  outboundMessage: { findMany: (...a: unknown[]) => state.outboundFindMany(...a) },
  callEvent: { findMany: (...a: unknown[]) => state.callEventFindMany(...a) },
} as unknown as PrismaClient;

const CONTACT = {
  id: 'contact_1',
  e164: '+34651234567',
  name: 'García',
  legalBasis: 'inbound_contact',
  legalBasisCapturedAt: monthsAgo(3),
};

const OPTS = { clientId: 'client_1', subscriptionId: 'sub_1', now: NOW };

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset().mockResolvedValue([]);
});

describe('findRecoveryCandidates — el disparador de presupuesto abierto', () => {
  beforeEach(() => {
    state.serviceQuoteFindMany.mockResolvedValue([
      { id: 'sq_1', amount: 1400, issuedAt: daysAgo(34), contact: CONTACT },
    ]);
  });

  it('propone el presupuesto con un motivo legible', async () => {
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]).toMatchObject({
      contactId: 'contact_1',
      trigger: 'open_quote',
      serviceQuoteId: 'sq_1',
      amount: 1400,
    });
    expect(run.candidates[0].reason).toMatch(/1\.?400\s*€.*34 días/);
  });

  it('solo mira presupuestos abiertos y no perseguidos todavía', async () => {
    await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    const where = state.serviceQuoteFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('open');
    expect(where.lastFollowedUpAt).toBeNull();
    // Sin contacto no hay a quién escribir.
    expect(where.contactId).toEqual({ not: null });
  });
});

describe('findRecoveryCandidates — las exclusiones se aplican SIEMPRE', () => {
  beforeEach(() => {
    state.serviceQuoteFindMany.mockResolvedValue([
      { id: 'sq_1', amount: 1400, issuedAt: daysAgo(34), contact: CONTACT },
    ]);
  });

  it('un contacto en la lista de supresión sale como excluido, no como candidato', async () => {
    state.blockedFindMany.mockResolvedValue([{ e164: '+34651234567' }]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });

    expect(run.candidates).toHaveLength(0);
    // Y CON SU MOTIVO: "no se le escribió" es algo que hay que poder
    // demostrar, y no aparecer en una lista no demuestra nada.
    expect(run.excluded).toEqual([
      { contactId: 'contact_1', e164: '+34651234567', trigger: 'open_quote', reason: 'suppressed' },
    ]);
  });

  it('un contacto escrito hace poco sale como excluido', async () => {
    state.outboundFindMany.mockResolvedValue([{ toE164: '+34651234567', sentAt: daysAgo(3) }]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run.excluded[0].reason).toBe('contacted_recently');
  });

  it('un contacto sin base legal sale como excluido — el backfill del histórico los dejó así a propósito', async () => {
    state.serviceQuoteFindMany.mockResolvedValue([
      {
        id: 'sq_1',
        amount: 1400,
        issuedAt: daysAgo(34),
        contact: { ...CONTACT, legalBasis: null, legalBasisCapturedAt: null },
      },
    ]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run.candidates).toHaveLength(0);
    expect(run.excluded[0].reason).toBe('no_legal_basis');
  });

  it('un contacto con devolución agendada sale como excluido', async () => {
    state.callEventFindMany.mockResolvedValue([{ contactId: 'contact_1' }]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run.excluded[0].reason).toBe('callback_scheduled');
  });

  it('la supresión se consulta por SUSCRIPCIÓN, no globalmente: la baja pedida a un cliente no silencia a otro', async () => {
    await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(state.blockedFindMany.mock.calls[0][0].where.subscriptionId).toBe('sub_1');
  });

  it('solo cuenta como "contacto reciente" un envío que SALIÓ — uno fallido no gastó el descanso de nadie', async () => {
    await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(state.outboundFindMany.mock.calls[0][0].where.ok).toBe(true);
  });
});

describe('findRecoveryCandidates — comportamiento general', () => {
  it('no consulta exclusiones cuando no hay ningún candidato: tres consultas para nada', async () => {
    const run = await findRecoveryCandidates(prisma, OPTS);
    expect(run).toEqual({ candidates: [], excluded: [] });
    expect(state.blockedFindMany).not.toHaveBeenCalled();
    expect(state.outboundFindMany).not.toHaveBeenCalled();
  });

  it('evalúa los tres disparadores cuando no se pide ninguno en concreto', async () => {
    await findRecoveryCandidates(prisma, OPTS);
    expect(state.serviceQuoteFindMany).toHaveBeenCalled();
    expect(state.jobFindMany).toHaveBeenCalled();
    expect(state.contactFindMany).toHaveBeenCalled();
  });

  it('el mismo contacto puede salir por dos disparadores: deduplicar es del motor de campañas, que sabe cuál vale más', async () => {
    state.serviceQuoteFindMany.mockResolvedValue([
      { id: 'sq_1', amount: 1400, issuedAt: daysAgo(34), contact: CONTACT },
    ]);
    state.jobFindMany.mockResolvedValue([
      { id: 'job_1', serviceType: 'revisión de caldera', nextServiceDueAt: daysAgo(-10), contact: CONTACT },
    ]);

    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote', 'service_anniversary'] });
    expect(run.candidates).toHaveLength(2);
    expect(run.candidates.map((c) => c.trigger)).toEqual(['open_quote', 'service_anniversary']);
  });

  it('descarta una fila cuyo contacto vino nulo en vez de reventar', async () => {
    state.serviceQuoteFindMany.mockResolvedValue([
      { id: 'sq_1', amount: 1400, issuedAt: daysAgo(34), contact: null },
    ]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run).toEqual({ candidates: [], excluded: [] });
  });

  it('un presupuesto sin importe no rompe el motivo', async () => {
    state.serviceQuoteFindMany.mockResolvedValue([
      { id: 'sq_1', amount: null, issuedAt: daysAgo(34), contact: CONTACT },
    ]);
    const run = await findRecoveryCandidates(prisma, { ...OPTS, triggers: ['open_quote'] });
    expect(run.candidates[0].reason).toContain('sin importe');
    expect(run.candidates[0].amount).toBeNull();
  });
});

// El guardia estructural: que no aparezca nunca una puerta trasera.
describe('la superficie del módulo', () => {
  it('no exporta ninguna forma de pedir candidatos sin filtrar', async () => {
    const mod = await import('@/lib/recovery-triggers');
    const exported = Object.keys(mod);
    // findRecoveryCandidates es la ÚNICA salida que devuelve candidatos.
    expect(exported.filter((k) => /candidates?$/i.test(k))).toEqual(['findRecoveryCandidates']);
    expect(exported).not.toContain('skipExclusions');
  });

  it('findRecoveryCandidates no acepta ninguna opción para saltarse las exclusiones', async () => {
    // Una opción de más aquí no la detectaría ningún test de
    // comportamiento: funcionaría perfectamente, y ese es el problema.
    const raw = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/recovery-triggers.ts', 'utf8'),
    );
    // Se quitan los comentarios antes de mirar. La primera versión de este
    // test se puso roja con el comentario que explica por qué
    // `skipExclusions` NO existe — un guardia que castiga documentar el
    // motivo empuja justo a lo contrario de lo que quiere conseguir.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Y el guardia del guardia: si el borrado de comentarios se comiera el
    // fichero entero, la aserción de abajo pasaría en verde sin mirar
    // nada — que es peor que no tenerla, porque además da confianza.
    expect(code).toMatch(/export async function findRecoveryCandidates/);
    expect(code).toMatch(/exclusionFor\(/);

    expect(code).not.toMatch(/skipExclusions|ignoreExclusions|bypass/i);
  });
});
