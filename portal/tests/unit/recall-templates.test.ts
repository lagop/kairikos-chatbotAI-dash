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
  markConnectionNeedsReconnect: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  createMessageTemplate: (...a: unknown[]) => mockState.createMessageTemplate(...a),
  sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a),
  isAccessTokenError: (r: { code?: number }) => r.code === 190,
}));

vi.mock('@/lib/whatsapp-health', () => ({
  markConnectionNeedsReconnect: (...a: unknown[]) => mockState.markConnectionNeedsReconnect(...a),
}));

vi.mock('@/lib/recall-messaging', () => ({
  RECALL_TEMPLATES: {
    callerOpen: { name: 'recall_caller_open', languageCode: 'es' },
    callerClosed: { name: 'recall_caller_closed', languageCode: 'es' },
    callerOpenWithNotice: { name: 'recall_caller_open_v2', languageCode: 'es' },
    callerClosedWithNotice: { name: 'recall_caller_closed_v2', languageCode: 'es' },
    ownerMessage: { name: 'recall_owner_message', languageCode: 'es' },
    callerSlots: { name: 'recall_caller_slots', languageCode: 'es' },
    callerSlotsWithNotice: { name: 'recall_caller_slots_v2', languageCode: 'es' },
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
  missingTemplateDefinitions,
  ensureRecallTemplatesSubmitted,
  reviewRequestTemplateDefinition,
  allRecallTemplateDefinitions,
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
  whatsappTemplateFindMany: vi.fn(),
  whatsappTemplateUpsert: vi.fn(),
  recallSubscriptionAuditCreate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findMany: (...a: unknown[]) => state.recallSubscriptionFindMany(...a),
    update: (...a: unknown[]) => state.recallSubscriptionUpdate(...a),
  },
  whatsappTemplate: {
    count: (...a: unknown[]) => state.whatsappTemplateCount(...a),
    findMany: (...a: unknown[]) => state.whatsappTemplateFindMany(...a),
    upsert: (...a: unknown[]) => state.whatsappTemplateUpsert(...a),
  },
  recallSubscriptionAudit: {
    create: (...a: unknown[]) => state.recallSubscriptionAuditCreate(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  // La invitación a reseña solo entra en la lista con un dominio https.
  vi.stubEnv('NEXT_PUBLIC_PORTAL_URL', 'https://portal.example');
  mockState.createMessageTemplate.mockReset();
  mockState.sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.metaSenderFor.mockReset().mockReturnValue({ token: 'tok', phoneNumberId: 'phone_1' });
  mockState.logError.mockReset();
  mockState.markConnectionNeedsReconnect.mockReset().mockResolvedValue({ flipped: true, notified: true });
  for (const fn of Object.values(state)) fn.mockReset();
  state.recallSubscriptionFindMany.mockResolvedValue([]);
  state.whatsappTemplateCount.mockResolvedValue(0);
  state.whatsappTemplateFindMany.mockResolvedValue([]);
  state.whatsappTemplateUpsert.mockResolvedValue({});
  state.recallSubscriptionUpdate.mockImplementation(({ data }) => Promise.resolve({ status: data.status }));
  state.recallSubscriptionAuditCreate.mockResolvedValue({});
});

describe('RECALL_TEMPLATE_DEFINITIONS', () => {
  it('defines exactly the 7 templates the product actually sends, all Spanish UTILITY', () => {
    expect(RECALL_TEMPLATE_DEFINITIONS).toHaveLength(7);
    const names = RECALL_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      'recall_caller_open_v2',
      'recall_caller_closed_v2',
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
  it('defines the 2 templates that exist but never gate onboarding — recall_caller_slots_v2 and recall_owner_callback', () => {
    expect(RECALL_OPTIONAL_TEMPLATE_DEFINITIONS).toHaveLength(2);
    const names = RECALL_OPTIONAL_TEMPLATE_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['recall_caller_slots_v2', 'recall_owner_callback']);
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
  const FIRST_CONTACT = ['recall_caller_open_v2', 'recall_caller_closed_v2', 'recall_caller_slots_v2'];

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
  it('submits all 13 templates (7 required + 2 optional + review request + 3 recovery) to the given WABA', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(13);
    expect(outcomes).toHaveLength(13);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => o.name)).toContain('recall_caller_slots_v2');
    expect(outcomes.map((o) => o.name)).toContain('recall_owner_callback');
    for (const call of mockState.createMessageTemplate.mock.calls) {
      expect(call[0]).toBe('token');
      expect(call[1]).toBe('waba_1');
    }
  });

  it('one rejected template does not stop the others from being submitted', async () => {
    mockState.createMessageTemplate.mockImplementation((_token, _waba, spec) => {
      if (spec.name === 'recall_caller_closed_v2') {
        return Promise.resolve({ ok: false, error: 'invalid wording' });
      }
      return Promise.resolve({ ok: true, data: { status: 'PENDING' } });
    });

    const outcomes = await submitAllRecallTemplates('token', 'waba_1');

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(13);
    const failed = outcomes.find((o) => o.name === 'recall_caller_closed_v2');
    expect(failed).toMatchObject({ ok: false, error: 'invalid wording' });
    expect(outcomes.filter((o) => o.ok)).toHaveLength(12);
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.submit_failed',
      expect.any(Error),
      expect.objectContaining({ wabaId: 'waba_1', template: 'recall_caller_closed_v2' }),
      'warn',
    );
  });

  it('never throws — a network failure on every call still returns 13 outcomes', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'network down' });
    const outcomes = await submitAllRecallTemplates('token', 'waba_1');
    expect(outcomes).toHaveLength(13);
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

// =============================================================================
// Fase 0 bis — las plantillas de primer contacto cambian de nombre al llevar
// el aviso, y los negocios ya conectados tienen que recibirlas igual.
// =============================================================================
describe('el nombre de las plantillas con aviso', () => {
  it('las definiciones que se envían a Meta usan los nombres *WithNotice que recall-messaging elige al enviar', async () => {
    // Sin mock: si alguien renombra en un lado y no en el otro, se enviaría
    // a Meta una plantilla que el código nunca usa — o se usaría una que
    // Meta nunca recibió.
    const actual = await vi.importActual<typeof import('@/lib/recall-messaging')>('@/lib/recall-messaging');
    const defined = new Set(
      [...RECALL_TEMPLATE_DEFINITIONS, ...RECALL_OPTIONAL_TEMPLATE_DEFINITIONS].map((t) => t.name),
    );
    for (const kind of ['open', 'closed', 'slots'] as const) {
      const { withNotice, legacy } = actual.CALLER_TEMPLATE_VARIANTS[kind];
      expect(defined.has(withNotice.name), `${withNotice.name} no se envía a Meta`).toBe(true);
      expect(defined.has(legacy.name), `${legacy.name} ya no debería enviarse: su cuerpo aprobado no lleva aviso`).toBe(false);
    }
  });

  it('toda definición cuyo cuerpo lleva el aviso tiene nombre _v2 — Meta no deja cambiar el cuerpo de una ya aprobada', () => {
    const withNotice = [...RECALL_TEMPLATE_DEFINITIONS, ...RECALL_OPTIONAL_TEMPLATE_DEFINITIONS].filter((t) =>
      t.bodyText.includes(LEGAL_NOTICE_TEXT),
    );
    // Guardia del guardia: si el filtro no encuentra nada, el bucle de abajo
    // pasaría en vacío.
    expect(withNotice.length).toBe(3);
    for (const def of withNotice) expect(def.name).toMatch(/_v2$/);
  });
});

describe('missingTemplateDefinitions', () => {
  it('devuelve todas si el espejo está vacío', () => {
    expect(missingTemplateDefinitions(new Set())).toHaveLength(13);
  });

  it('el caso real de producción: aprobadas las antiguas, faltan las tres _v2 y las cuatro que nunca se enviaron', () => {
    const existing = new Set([
      'recall_caller_open',
      'recall_caller_closed',
      'recall_caller_slots',
      'recall_owner_message',
      'recall_daily_digest',
      'recall_digest_clarify',
      'recall_monthly_report',
      'recall_forwarding_instructions',
      'recall_owner_callback',
    ]);
    expect(missingTemplateDefinitions(existing).map((t) => t.name)).toEqual([
      'recall_caller_open_v2',
      'recall_caller_closed_v2',
      'recall_caller_slots_v2',
      'recall_review_request',
      'recovery_open_quote',
      'recovery_service_due',
      'recovery_dormant',
    ]);
  });

  it('sin dominio del portal no envía la invitación a reseña — su URL quedaría grabada en Meta', () => {
    // '' y no undefined: undefined activa el valor por defecto (la variable
    // de entorno, que este archivo fija en beforeEach).
    const names = missingTemplateDefinitions(new Set(), '').map((t) => t.name);
    expect(names).not.toContain('recall_review_request');
    expect(names).toHaveLength(12);
    expect(missingTemplateDefinitions(new Set(), 'http://localhost:3000').map((t) => t.name)).not.toContain(
      'recall_review_request',
    );
  });
});

describe('las plantillas que se enviaban sin existir en Meta', () => {
  it('la invitación a reseña: MARKETING, con aviso, y un botón que termina en el id de seguimiento', () => {
    const def = reviewRequestTemplateDefinition('https://portal.example/');
    expect(def).toMatchObject({ name: 'recall_review_request', languageCode: 'es', category: 'MARKETING' });
    expect(def?.bodyText).toContain(LEGAL_NOTICE_TEXT);
    expect(def?.bodyText.trim().endsWith('}}')).toBe(false);
    // Un solo {{1}} en el cuerpo, que es lo único que sendReviewRequest
    // manda como bodyParams (el nombre del negocio).
    expect(new Set(def?.bodyText.match(/\{\{\d+\}\}/g))).toEqual(new Set(['{{1}}']));
    expect(def?.bodyExamples).toHaveLength(1);
    // Sin barra doble: la barra final del dominio se quita.
    expect(def?.urlButton?.url).toBe('https://portal.example/r/{{1}}');
    expect(def?.urlButton?.example.startsWith('https://portal.example/r/')).toBe(true);
  });

  it('las recovery_* se envían con el cuerpo y la categoría exactos de recovery-templates.ts', async () => {
    const { RECOVERY_TEMPLATE_DEFINITIONS } = await import('@/lib/recovery-templates');
    const all = allRecallTemplateDefinitions('https://portal.example');
    for (const rec of RECOVERY_TEMPLATE_DEFINITIONS) {
      const def = all.find((t) => t.name === rec.name);
      expect(def, `falta ${rec.name}`).toBeTruthy();
      expect(def).toEqual({
        name: rec.name,
        languageCode: rec.languageCode,
        category: rec.category,
        bodyText: rec.bodyText,
        bodyExamples: rec.bodyExamples,
      });
    }
  });

  it('ningún nombre se repite en la lista completa', () => {
    const names = allRecallTemplateDefinitions('https://portal.example').map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('el botón de URL llega a Meta al enviar la lista completa', async () => {
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });
    await submitAllRecallTemplates('token', 'waba_1');
    const review = mockState.createMessageTemplate.mock.calls.find((c) => c[2].name === 'recall_review_request');
    expect(review?.[2].urlButton).toEqual(
      expect.objectContaining({ url: 'https://portal.example/r/{{1}}', text: expect.any(String) }),
    );
  });
});

describe('ensureRecallTemplatesSubmitted', () => {
  const CONNECTION = {
    id: 'conn_1',
    clientId: 'client_1',
    wabaId: 'waba_1',
    externalId: 'phone_1',
    status: 'active',
    accessTokenCiphertext: Buffer.from('ct'),
    accessTokenIv: Buffer.from('iv'),
    accessTokenTag: Buffer.from('tag'),
  };
  const ALL_BUT_V2 = [
    'recall_owner_message',
    'recall_daily_digest',
    'recall_digest_clarify',
    'recall_monthly_report',
    'recall_forwarding_instructions',
    'recall_owner_callback',
    'recall_review_request',
    'recovery_open_quote',
    'recovery_service_due',
    'recovery_dormant',
  ].map((name) => ({ name }));

  it('solo mira suscripciones vivas con conexión — ni canceladas ni previas a conectar WhatsApp', async () => {
    await ensureRecallTemplatesSubmitted(prisma);
    expect(state.recallSubscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { notIn: ['cancelled', 'paid', 'contract_signed'] }, metaConnectionId: { not: null } },
      }),
    );
  });

  it('envía solo lo que falta y lo deja en el espejo con el estado que devuelve Meta', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue(ALL_BUT_V2);
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { id: 'tpl_9', status: 'PENDING' } });
    const now = new Date('2026-09-15T10:00:00Z');

    const result = await ensureRecallTemplatesSubmitted(prisma, { now });

    expect(result).toEqual({ connections: 1, submitted: 3, failed: 0 });
    expect(mockState.createMessageTemplate.mock.calls.map((c) => c[2].name)).toEqual([
      'recall_caller_open_v2',
      'recall_caller_closed_v2',
      'recall_caller_slots_v2',
    ]);
    expect(mockState.createMessageTemplate.mock.calls[0][0]).toBe('tok');
    expect(mockState.createMessageTemplate.mock.calls[0][1]).toBe('waba_1');
    expect(state.whatsappTemplateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          clientId: 'client_1',
          connectionId: 'conn_1',
          name: 'recall_caller_open_v2',
          metaTemplateId: 'tpl_9',
          status: 'PENDING',
          lastCheckedAt: now,
        }),
        update: expect.objectContaining({ status: 'PENDING', metaTemplateId: 'tpl_9', lastCheckedAt: now }),
      }),
    );
  });

  it('un rechazo al crear queda como SUBMIT_FAILED con el motivo — así no se reenvía cada cinco minutos', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue(ALL_BUT_V2);
    mockState.createMessageTemplate.mockImplementation((_t, _w, spec) =>
      spec.name === 'recall_caller_closed_v2'
        ? Promise.resolve({ ok: false, error: 'Invalid parameter' })
        : Promise.resolve({ ok: true, data: { status: 'PENDING' } }),
    );

    const result = await ensureRecallTemplatesSubmitted(prisma);

    expect(result).toEqual({ connections: 1, submitted: 2, failed: 1 });
    expect(state.whatsappTemplateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          name: 'recall_caller_closed_v2',
          status: 'SUBMIT_FAILED',
          rejectedReason: 'Invalid parameter',
        }),
      }),
    );
    expect(mockState.logError).toHaveBeenCalledWith(
      'recall_templates.ensure_submit_failed',
      expect.any(Error),
      expect.objectContaining({ connectionId: 'conn_1', template: 'recall_caller_closed_v2' }),
      'warn',
    );
  });

  // 2026-09-15 — el primer despliegue marcó las siete plantillas nuevas como
  // SUBMIT_FAILED por un token caducado. Eso no dice nada de la plantilla.
  it('un token caducado (code 190) no marca la plantilla: marca la conexión y deja de intentarlo', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue(ALL_BUT_V2);
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'Session has expired', code: 190 });
    const now = new Date('2026-09-15T20:03:40Z');

    const result = await ensureRecallTemplatesSubmitted(prisma, { now });

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(1);
    expect(state.whatsappTemplateUpsert).not.toHaveBeenCalled();
    expect(mockState.markConnectionNeedsReconnect).toHaveBeenCalledWith(prisma, 'conn_1', 'Session has expired', now);
    expect(result).toEqual({ connections: 1, submitted: 0, failed: 1 });
  });

  it('reintenta un SUBMIT_FAILED de hace más de un día, y no uno reciente', async () => {
    const now = new Date('2026-09-17T10:00:00Z');
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue([
      ...ALL_BUT_V2,
      { name: 'recall_caller_open_v2', status: 'SUBMIT_FAILED', lastCheckedAt: new Date('2026-09-15T20:03:40Z') },
      { name: 'recall_caller_closed_v2', status: 'SUBMIT_FAILED', lastCheckedAt: new Date('2026-09-17T09:00:00Z') },
      { name: 'recall_caller_slots_v2', status: 'PENDING', lastCheckedAt: new Date('2026-09-15T20:03:40Z') },
    ]);
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { id: 'tpl_1', status: 'PENDING' } });

    const result = await ensureRecallTemplatesSubmitted(prisma, { now });

    expect(mockState.createMessageTemplate.mock.calls.map((c) => c[2].name)).toEqual(['recall_caller_open_v2']);
    expect(result.submitted).toBe(1);
    // La fila existente pasa a lo que dice Meta ahora.
    expect(state.whatsappTemplateUpsert.mock.calls[0][0].update).toEqual({
      metaTemplateId: 'tpl_1',
      status: 'PENDING',
      rejectedReason: null,
      lastCheckedAt: now,
    });
  });

  it('si el reintento vuelve a fallar, solo actualiza motivo y fecha — el estado lo decide Meta', async () => {
    const now = new Date('2026-09-17T10:00:00Z');
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue([
      ...ALL_BUT_V2,
      { name: 'recall_caller_open_v2', status: 'SUBMIT_FAILED', lastCheckedAt: new Date('2026-09-15T20:03:40Z') },
      { name: 'recall_caller_closed_v2' },
      { name: 'recall_caller_slots_v2' },
    ]);
    mockState.createMessageTemplate.mockResolvedValue({ ok: false, error: 'Invalid parameter', code: 100 });

    await ensureRecallTemplatesSubmitted(prisma, { now });

    expect(state.whatsappTemplateUpsert.mock.calls[0][0].update).toEqual({
      rejectedReason: 'Invalid parameter',
      lastCheckedAt: now,
    });
  });

  it('no reenvía nada que ya esté en el espejo, tenga el estado que tenga', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue([
      ...ALL_BUT_V2,
      { name: 'recall_caller_open_v2' },
      { name: 'recall_caller_closed_v2' },
      { name: 'recall_caller_slots_v2' },
    ]);

    const result = await ensureRecallTemplatesSubmitted(prisma);

    expect(result).toEqual({ connections: 1, submitted: 0, failed: 0 });
    expect(mockState.createMessageTemplate).not.toHaveBeenCalled();
  });

  it('una conexión compartida por dos suscripciones se procesa una sola vez', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([{ metaConnection: CONNECTION }, { metaConnection: CONNECTION }]);
    state.whatsappTemplateFindMany.mockResolvedValue(ALL_BUT_V2);
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });

    const result = await ensureRecallTemplatesSubmitted(prisma);

    expect(result.connections).toBe(1);
    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(3);
  });

  it('salta conexiones sin WABA o sin remitente válido', async () => {
    state.recallSubscriptionFindMany.mockResolvedValue([
      { metaConnection: { ...CONNECTION, id: 'conn_nowaba', wabaId: null } },
      { metaConnection: { ...CONNECTION, id: 'conn_nosender' } },
    ]);
    mockState.metaSenderFor.mockReturnValue(null);

    const result = await ensureRecallTemplatesSubmitted(prisma);

    expect(result).toEqual({ connections: 0, submitted: 0, failed: 0 });
    expect(mockState.createMessageTemplate).not.toHaveBeenCalled();
  });

  it('respeta el tope de 20 envíos por ciclo', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ metaConnection: { ...CONNECTION, id: `conn_${i}` } }));
    state.recallSubscriptionFindMany.mockResolvedValue(many);
    mockState.createMessageTemplate.mockResolvedValue({ ok: true, data: { status: 'PENDING' } });

    const result = await ensureRecallTemplatesSubmitted(prisma);

    expect(mockState.createMessageTemplate).toHaveBeenCalledTimes(20);
    expect(result.submitted).toBe(20);
  });
});
