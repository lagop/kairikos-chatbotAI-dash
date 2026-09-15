// =============================================================================
// Fase 1 — tests de la resolución de contactos.
//
// Dos propiedades cargan con casi todo el peso, y las dos son de las que
// fallan en silencio:
//
//   · La normalización tiene que coincidir EXACTAMENTE con la de la lista
//     de bloqueo. Un contacto '+34651234567' y un bloqueo '651234567' son
//     dos personas distintas para Postgres, y la baja de una no silencia
//     a la otra. Por eso hay un test que compara las dos rutas.
//
//   · lastInteractionAt no puede retroceder. Twilio reentrega webhooks, y
//     un reintento tardío de una llamada vieja haría parecer dormido a un
//     cliente al que se acaba de atender — justo al revés de lo que
//     necesitan los disparadores de la Fase 3.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { resolveContact, recordLegalBasis, hasCampaignableLegalBasis } from '@/lib/contacts';
import { normaliseE164 } from '@/lib/recall-blocklist';

const state = {
  upsert: vi.fn(),
  updateMany: vi.fn(),
};

const prisma = {
  contact: {
    upsert: (...a: unknown[]) => state.upsert(...a),
    updateMany: (...a: unknown[]) => state.updateMany(...a),
  },
} as unknown as PrismaClient;

const AT = new Date('2026-09-15T10:00:00Z');
const BASE = { clientId: 'client_1', tenantId: 'tenant_1', rawNumber: '+34651234567', at: AT };

beforeEach(() => {
  state.upsert.mockReset().mockResolvedValue({ id: 'contact_1' });
  state.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockState.logError.mockReset();
});

describe('resolveContact', () => {
  it('deduplica por (cliente, número), nunca por número solo', async () => {
    await resolveContact(prisma, BASE);
    expect(state.upsert.mock.calls[0][0].where).toEqual({
      clientId_e164: { clientId: 'client_1', e164: '+34651234567' },
    });
  });

  it('al crearlo guarda las dos fechas iguales y el origen', async () => {
    await resolveContact(prisma, BASE);
    expect(state.upsert.mock.calls[0][0].create).toMatchObject({
      clientId: 'client_1',
      tenantId: 'tenant_1',
      e164: '+34651234567',
      source: 'inbound_call',
      firstSeenAt: AT,
      lastInteractionAt: AT,
    });
  });

  it('el upsert NO toca nada al encontrarlo: firstSeenAt es sagrado', async () => {
    await resolveContact(prisma, BASE);
    expect(state.upsert.mock.calls[0][0].update).toEqual({});
  });

  it('normaliza lo que llega igual que la lista de bloqueo — si divergieran, una baja dejaría de silenciar a su contacto', async () => {
    for (const typed of ['651 23 45 67', '+34 651 23 45 67', '0034651234567']) {
      state.upsert.mockClear();
      await resolveContact(prisma, { ...BASE, rawNumber: typed });
      expect(state.upsert.mock.calls[0][0].where.clientId_e164.e164).toBe(normaliseE164(typed));
      expect(state.upsert.mock.calls[0][0].where.clientId_e164.e164).toBe('+34651234567');
    }
  });

  // La razón de que el avance vaya en su propia consulta condicional en
  // vez de dentro del upsert.
  it('adelanta lastInteractionAt SOLO si la interacción es más reciente', async () => {
    await resolveContact(prisma, BASE);
    expect(state.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'contact_1', lastInteractionAt: { lt: AT } },
      data: { lastInteractionAt: AT },
    });
  });

  it('devuelve null sin tocar la base cuando no hay número (llamada oculta)', async () => {
    await expect(resolveContact(prisma, { ...BASE, rawNumber: null })).resolves.toBeNull();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('devuelve null cuando el número no se puede leer, en vez de guardar una fila que no casará con nada', async () => {
    await expect(resolveContact(prisma, { ...BASE, rawNumber: 'anonymous' })).resolves.toBeNull();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('NUNCA lanza: si esto tumbara el webhook de voz, Twilio reintentaría la llamada entera', async () => {
    state.upsert.mockRejectedValue(new Error('postgres caído'));
    await expect(resolveContact(prisma, BASE)).resolves.toBeNull();
    expect(mockState.logError).toHaveBeenCalledWith(
      'contacts.resolve_failed',
      expect.any(Error),
      expect.objectContaining({ clientId: 'client_1' }),
      'warn',
    );
  });
});

describe('recordLegalBasis', () => {
  const INPUT = {
    contactId: 'contact_1',
    evidenceCallEventId: 'ce_1',
    capturedAt: AT,
  };

  it('sella la base con el puntero al hecho que la acredita', async () => {
    await recordLegalBasis(prisma, INPUT);
    expect(state.updateMany.mock.calls[0][0].data).toEqual({
      legalBasis: 'inbound_contact',
      legalBasisCapturedAt: AT,
      legalBasisEvidenceId: 'ce_1',
    });
  });

  // LA PRIMERA GANA. La base legal se captura en el momento de recoger el
  // dato; un aviso enviado seis meses más tarde no mejora al primero.
  it('solo escribe si no había base todavía, lo que además lo hace idempotente', async () => {
    await recordLegalBasis(prisma, INPUT);
    expect(state.updateMany.mock.calls[0][0].where).toEqual({ id: 'contact_1', legalBasis: null });
  });

  it('no lanza — el mensaje ya salió y un fallo aquí no puede provocar un reenvío', async () => {
    state.updateMany.mockRejectedValue(new Error('postgres caído'));
    await expect(recordLegalBasis(prisma, INPUT)).resolves.toBeUndefined();
    expect(mockState.logError).toHaveBeenCalledWith(
      'contacts.legal_basis_failed',
      expect.any(Error),
      expect.objectContaining({ contactId: 'contact_1' }),
      'warn',
    );
  });
});

describe('hasCampaignableLegalBasis', () => {
  it('un contacto sin base legal no entra en campañas', () => {
    expect(hasCampaignableLegalBasis({ legalBasis: null })).toBe(false);
  });

  it('con base legal, sí', () => {
    expect(hasCampaignableLegalBasis({ legalBasis: 'inbound_contact' })).toBe(true);
  });
});
