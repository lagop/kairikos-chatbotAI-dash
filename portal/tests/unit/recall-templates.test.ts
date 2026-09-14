// =============================================================================
// WP-XX — unit tests for src/lib/recall-templates.ts: submitting recall's
// 6 WhatsApp templates to a client's WABA.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  createMessageTemplate: vi.fn(),
  sendTemplate: vi.fn(),
  metaSenderFor: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
  sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a),
}));

vi.mock('@/lib/recall-messaging', () => ({
  RECALL_TEMPLATES: {
    callerOpen: { name: 'recall_caller_open', languageCode: 'es' },
    callerClosed: { name: 'recall_caller_closed', languageCode: 'es' },
    ownerMessage: { name: 'recall_owner_message', languageCode: 'es' },
    callerSlots: { name: 'recall_caller_slots', languageCode: 'es' },
    ownerCallback: { name: 'recall_owner_callback', languageCode: 'es' },
  },
  metaSenderFor: (...a: unknown[]) => mockState.metaSenderFor(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  submitAllRecallTemplates,
  advanceSubscriptionsWithApprovedTemplates,
  RECALL_TEMPLATE_DEFINITIONS,
  RECALL_OPTIONAL_TEMPLATE_DEFINITIONS,
} from '@/lib/recall-templates';
// Sin mockear a propósito: el test compara contra el texto REAL que se va
// a enviar. Un doble aquí comprobaría que dos constantes falsas coinciden.
import { LEGAL_NOTICE_TEXT } from '@/lib/recall-optout';

const state = {
  recallSubscriptionFindMany: vi.fn(),
  recallSubscriptionUpdate: vi.fn(),
  whatsappTemplateCount: vi.fn(),
  recallSubscriptionAuditCreate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findMany: (...a: unknown[]) => state.recallSubscriptionFindMany(...a),
    update: (...a: unknown[]) => state.recallSubscriptionUpdate(...a),
  },
  whatsappTemplate: {
    count: (...a: unknown[]) => state.whatsappTemplateCount(...a),
  },
  recallSubscriptionAudit: {
    create: (...a: unknown[]) => state.recallSubscriptionAuditCreate(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  mockState.createMessageTemplate.mockReset();
  mockState.sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.metaSenderFor.mockReset().mockReturnValue({ token: 'tok', phoneNumberId: 'phone_1' });
  mockState.logError.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
  state.recallSubscriptionFindMany.mockResolvedValue([]);
  state.whatsappTemplateCount.mockResolvedValue(0);
  state.recallSubscriptionUpdate.mockImplementation(({ data }) => Promise.resolve({ status: data.status }));
  state.recallSubscriptionAuditCreate.mockResolvedValue({});
});

describe('RECALL_TEMPLATE_DEFINITIONS', () => {
  it('defines exactly the 7 templates the product actually sends, all Spanish UTILITY', () => {
    expect(RECALL_TEMPLATE_DEFINITIONS).toHaveLength(7);
    const names = RECALL_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      'recall_caller_open',
      'recall_caller_closed',
      'recall_owner_message',
      'recall_daily_digest',
      'recall_digest_clarify',
      'recall_monthly_report',
      'recall_forwarding_instructions',
    ]);
    for (const def of RECALL_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
      expect(def.category).toBe('UTILITY');
    }
  });

  it('gives every UNIQUE {{n}} placeholder in the body text a matching example — a repeated placeholder reuses one example, not one per occurrence', () => {
    for (const def of RECALL_TEMPLATE_DEFINITIONS) {
      const uniquePlaceholders = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.bodyExamples).toHaveLength(uniquePlaceholders.size);
    }
  });

  it('the forwarding-instructions template uses the 3 conditional-forwarding MMI codes, never unconditional forwarding', () => {
    const def = RECALL_TEMPLATE_DEFINITIONS.find((t) => t.name === 'recall_forwarding_instructions');
    expect(def?.bodyText).toContain('**61*');
    expect(def?.bodyText).toContain('**67*');
    expect(def?.bodyText).toContain('**62*');
    // Unconditional forwarding (**21*) would forward EVERY call, defeating
    // a missed-call product's whole point — the client must keep
    // answering calls himself when he can.
    expect(def?.bodyText).not.toContain('**21*');
  });
});

describe('RECALL_OPTIONAL_TEMPLATE_DEFINITIONS', () => {
  it('defines the 2 templates that exist but never gate onboarding — recall_caller_slots and recall_owner_callback', () => {
    expect(RECALL_OPTIONAL_TEMPLATE_DEFINITIONS).toHaveLength(2);
    const names = RECALL_OPTIONAL_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['recall_caller_slots', 'recall_owner_callback']);
    for (const def of RECALL_OPTIONAL_TEMPLATE_DEFINITIONS) {
      expect(def.languageCode).toBe('es');
      expect(def.category).toBe('UTILITY');
    }
  });

  it('gives every UNIQUE {{n}} placeholder a matching example, same rule as the required set', () => {
    for (const def of RECALL_OPTIONAL_TEMPLATE_DEFINITIONS) {
      const uniquePlaceholders = new Set(def.bodyText.match(/\{\{\d+\}\}/g) ?? []);
      expect(def.bodyExamples).toHaveLength(uniquePlaceholders.size);
    }
  });

  it('never ends on a variable — the exact Meta rejection (error_subcode 2388299) already hit twice in the required set', () => {
    for (const def of RECALL_OPTIONAL_TEMPLATE_DEFINITIONS) {
      expect(def.bodyText.trim().endsWith('}}')).toBe(false);
    }
  });
});

// =============================================================================
// Fase 0 — el guardia del aviso de oposición.
//
// Esto no comprueba una redacción bonita: comprueba la condición de la que
// depende que los números que recall acumula sirvan después para algo. Si
// alguien quita el aviso de una plantilla de primer contacto, este bloque
// se pone rojo antes de que la plantilla llegue a Meta — que es el único
// momento en el que arreglarlo sigue siendo barato.
// =============================================================================
describe('el aviso de oposición en el primer contacto', () => {
  /** Las tres que puede recibir alguien que nunca ha hablado con el negocio. */
  const FIRST_CONTACT = ['recall_caller_open', 'recall_caller_closed', 'recall_caller_slots'];

  const all = [...RECALL_TEMPLATE_DEFINITIONS, ...RECALL_OPTIONAL_TEMPLATE_DEFINITIONS];

  it('las tres plantillas de primer contacto lo llevan', () => {
    for (const name of FIRST_CONTACT) {
      const def = all.find((t) => t.name === name);
      expect(def, `falta la plantilla ${name}`).toBeTruthy();
      expect(def?.bodyText, `${name} se ha quedado sin aviso de oposición`).toContain(LEGAL_NOTICE_TEXT);
    }
  });

  it('las que van al DUEÑO no lo llevan — es su propio producto, no una comunicación a un tercero', () => {
    const ownerFacing = all.filter((t) => !FIRST_CONTACT.includes(t.name));
    for (const def of ownerFacing) {
      expect(def.bodyText, `${def.name} no debería llevar el aviso`).not.toContain(LEGAL_NOTICE_TEXT);
    }
  });

  it('añadir el aviso deja el cuerpo terminando en texto, nunca en {{n}} (error_subcode 2388299)', () => {
    for (const name of FIRST_CONTACT) {
      const def = all.find((t) => t.name === name);
      expect(def?.bodyText.trim().endsWith('}}')).toBe(false);
    }
  });
});

describe('submitAllRecallTemplates', () => {
  it('submits all 9 templates (7 required + 2 optional) to the given WABA', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(9);
    expect(outcomes).toHaveLength(9);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.name)).toContain('recall_caller_slots');
    expect(outcomes.map((o) => o.name)).toContain('recall_owner_callback');
    for (const call of mockState.createMessageTemplate.mock.calls) {
      expect(call[0]).toBe('token');
      expect(call[1]).toBe('waba_1');
    }
  });

  it('one rejected template does not stop the others from being submitted', async () => {
    mockState.createMessageTemplate.mockImplementation((_token, _waba, spec) => {
      if (spec.name === 'recall_caller_closed') {
        return Promise.resolve({ ok: false, error: 'invalid wording' });
      }
      return Promise.resolve({ ok: true, data: { status: 'PENDING' } });
    });

    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(9);
    const failed = outcomes.find((o) => o.name === 'recall_caller_closed');
    expect(failed).toMatchObject({ ok: false, error: 'invalid wording' });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(8);
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.submit_failed',
      expect.any(Error),
      expect.objectContaining({ wabaId: 'waba_1', template: 'recall_caller_closed' }),
      'warn',
    );
  });

  it('never throws — a network failure on every call still returns 9 outcomes', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'network down' });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');
    expect(outcomes).toHaveLength(9);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });
});

describe('advanceSubscriptionsWithApprovedTemplates', () => {
  const SUB = {
    id: 'sub_1',
    clientId: 'client_1',
    status: 'number_assigned',
    metaConnectionId: 'conn_1',
    ownerWhatsapp: '+34600000000',
    virtualNumber: { e164: '+34910123456' },
    metaConnection: {
      id: 'conn_1',
      externalId: 'phone_1',
      status: 'active',
      accessTokenCiphertext: Buffer.from('ct'),
      accessTokenIv: Buffer.from('iv'),
      accessTokenTag: Buffer.from('tag'),
    },
  };

  it('scopes the candidate query to number_assigned subscriptions with a bound connection', async () => {
    await advanceSubscriptionsWithApprovedTemplates(prisma);
    expect(state.recallSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'number_assigned', metaConnectionId: { not: null } },
      }),
    );
  });

  it('advances templates_approved → forwarding_pending once all 7 required templates are APPROVED, sending the forwarding instructions in between', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([SUB]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);
    const now = new Date('2026-09-01T00:00:00Z');

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma, { now });

    expect(result).toEqual({ advanced: 1 });
    expect(state.whatsappTemplateCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ connectionId: 'conn_1', status: 'APPROVED' }),
      }),
    );
    expect(state.recallSubscriptionUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'sub_1' },
      data: { status: 'templates_approved', templatesApprovedAt: now },
      select: { status: true },
    });
    // Sent to the OWNER (not the caller), with the virtual number as the
    // forwarding target — same sender resolution as every other recall
    // WhatsApp send.
    expect(mockState.sendTemplate).toHaveBeenCalledWith(
      'tok',
      'phone_1',
      '+34600000000',
      expect.objectContaining({ name: 'recall_forwarding_instructions', bodyParams: ['+34910123456'] }),
    );
    expect(state.recallSubscriptionUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 'sub_1' },
      data: { status: 'forwarding_pending' },
      select: { status: true },
    });
    expect(state.recallSubscriptionAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionId: 'sub_1', action: 'templates_approved', actorType: 'system' }),
      }),
    );
    expect(state.recallSubscriptionAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionId: 'sub_1', action: 'forwarding_pending', actorType: 'system' }),
      }),
    );
  });

  it('does not advance when only some of the 7 required templates are approved', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([SUB]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length - 1);

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 0 });
    expect(state.recallSubscriptionUpdate).not.toHaveBeenCalled();
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('still advances to forwarding_pending when the WhatsApp send fails — the state fact does not depend on the notification', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([SUB]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'template paused' });

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 1 });
    expect(state.recallSubscriptionUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { status: 'forwarding_pending' } }),
    );
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.forwarding_instructions_send_failed',
      expect.any(Error),
      expect.objectContaining({ subscriptionId: 'sub_1' }),
      'warn',
    );
  });

  it('still advances, skipping the send, when there is no valid sender/number/owner WhatsApp', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ ...SUB, ownerWhatsapp: null }]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 1 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.forwarding_instructions_send_skipped',
      expect.any(Error),
      expect.objectContaining({ subscriptionId: 'sub_1' }),
      'warn',
    );
  });

  it('one subscription failing its audit write does not stop the others from advancing', async () => {
    const sub2 = { ...SUB, id: 'sub_2', clientId: 'client_2' };
    state.recallSubscriptionFindMany.mockResolvedValue([SUB, sub2]);
    state.whatsappTemplateCount.mockResolvedValue(RECALL_TEMPLATE_DEFINITIONS.length);
    state.recallSubscriptionAuditCreate.mockRejectedValueOnce(new Error('db down'));

    const result = await advanceSubscriptionsWithApprovedTemplates(prisma);

    expect(result).toEqual({ advanced: 2 });
    expect(state.recallSubscriptionUpdate).toHaveBeenCalledTimes(4);
  });
});
