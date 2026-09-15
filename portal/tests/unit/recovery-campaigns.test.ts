// =============================================================================
// Fase 3 — tests de las campañas de recuperación.
//
// Dos propiedades cargan con todo el peso, y las dos son de seguridad:
//
//   1. NO SE ENVÍA NADA SIN APROBAR. Un fallo aquí manda una campaña que
//      nadie ha revisado a doscientos clientes reales del profesional.
//   2. LAS EXCLUSIONES SE VUELVEN A EVALUAR AL ENVIAR. Un fallo aquí le
//      escribe a alguien que pidió la baja entre la aprobación y el envío.
//
// El resto del fichero es plumbing comparado con esas dos.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  sendTemplate: vi.fn(),
  decryptMetaToken: vi.fn(),
  findRecoveryCandidates: vi.fn(),
  recordSend: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a),
}));
vi.mock('@/lib/meta-business', () => ({
  decryptMetaToken: (...a: unknown[]) => mockState.decryptMetaToken(...a),
}));
vi.mock('@/lib/message-ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/message-ledger')>('@/lib/message-ledger');
  return { ...actual, recordSend: (...a: unknown[]) => mockState.recordSend(...a) };
});
vi.mock('@/lib/recovery-triggers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recovery-triggers')>('@/lib/recovery-triggers');
  // exclusionFor se deja REAL: es la función cuya lógica queremos ver
  // ejecutarse en el envío, no un doble que diga lo que nos convenga.
  return { ...actual, findRecoveryCandidates: (...a: unknown[]) => mockState.findRecoveryCandidates(...a) };
});
vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { draftCampaign, approveCampaign, sendApprovedCampaign } from '@/lib/recovery-campaigns';

const NOW = new Date('2026-09-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const monthsAgo = (n: number) => {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - n);
  return d;
};

const state = {
  campaignCreate: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignUpdate: vi.fn(),
  campaignUpdateMany: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(),
  memberCount: vi.fn(),
  connectionFindFirst: vi.fn(),
  blockedFindMany: vi.fn(),
  outboundFindMany: vi.fn(),
  quoteUpdateMany: vi.fn(),
};

const prisma = {
  recoveryCampaign: {
    create: (...a: unknown[]) => state.campaignCreate(...a),
    findUnique: (...a: unknown[]) => state.campaignFindUnique(...a),
    update: (...a: unknown[]) => state.campaignUpdate(...a),
    updateMany: (...a: unknown[]) => state.campaignUpdateMany(...a),
  },
  recoveryCampaignMember: {
    findMany: (...a: unknown[]) => state.memberFindMany(...a),
    update: (...a: unknown[]) => state.memberUpdate(...a),
    count: (...a: unknown[]) => state.memberCount(...a),
  },
  metaChannelConnection: { findFirst: (...a: unknown[]) => state.connectionFindFirst(...a) },
  recallBlockedNumber: { findMany: (...a: unknown[]) => state.blockedFindMany(...a) },
  outboundMessage: { findMany: (...a: unknown[]) => state.outboundFindMany(...a) },
  serviceQuote: { updateMany: (...a: unknown[]) => state.quoteUpdateMany(...a) },
} as unknown as PrismaClient;

/** Un miembro al que SÍ se le puede escribir cuando llega el envío. */
const MEMBER = {
  id: 'm_1',
  contactId: 'contact_1',
  e164: '+34651234567',
  contact: { name: 'García Pérez', legalBasis: 'inbound_contact', legalBasisCapturedAt: monthsAgo(3) },
};

const APPROVED_CAMPAIGN = {
  id: 'camp_1',
  clientId: 'client_1',
  tenantId: 'tenant_1',
  subscriptionId: 'sub_1',
  trigger: 'open_quote',
  status: 'approved',
};

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  for (const fn of Object.values(mockState)) fn.mockReset();

  mockState.sendTemplate.mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.decryptMetaToken.mockReturnValue('token');
  mockState.recordSend.mockResolvedValue(undefined);

  state.campaignFindUnique.mockResolvedValue(APPROVED_CAMPAIGN);
  state.campaignUpdate.mockResolvedValue({});
  state.memberFindMany.mockResolvedValue([MEMBER]);
  state.memberUpdate.mockResolvedValue({});
  state.memberCount.mockResolvedValue(0);
  state.blockedFindMany.mockResolvedValue([]);
  state.outboundFindMany.mockResolvedValue([]);
  state.quoteUpdateMany.mockResolvedValue({ count: 1 });
  state.connectionFindFirst.mockResolvedValue({
    externalId: 'phone_1',
    accessTokenCiphertext: Buffer.from(''),
    accessTokenIv: Buffer.from(''),
    accessTokenTag: Buffer.from(''),
    client: { name: 'Juan', companyName: 'Fontanería Aurora' },
  });
});

// ===========================================================================
// 1. Nada sale sin aprobar
// ===========================================================================
describe('sendApprovedCampaign — la aprobación no es opcional', () => {
  it.each(['draft', 'cancelled', 'completed', 'sending'])(
    'se NIEGA a enviar una campaña en estado %s, y no manda ni un mensaje',
    async (status) => {
      state.campaignFindUnique.mockResolvedValue({ ...APPROVED_CAMPAIGN, status });
      const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });

      expect(result.skipped).toBe('not_approved');
      expect(mockState.sendTemplate).not.toHaveBeenCalled();
      // Y ni siquiera llega a leer la lista: se para antes.
      expect(state.memberFindMany).not.toHaveBeenCalled();
    },
  );

  it('se niega también con una campaña que no existe', async () => {
    state.campaignFindUnique.mockResolvedValue(null);
    const result = await sendApprovedCampaign(prisma, 'camp_x', { now: NOW });
    expect(result.skipped).toBe('not_approved');
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('envía cuando está aprobada', async () => {
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(result).toMatchObject({ sent: 1, failed: 0, excludedLate: 0 });
    expect(mockState.sendTemplate).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. Las exclusiones se vuelven a evaluar al enviar
// ===========================================================================
describe('sendApprovedCampaign — quien se fue entre la aprobación y el envío', () => {
  it('NO le escribe a quien pidió la baja después de aprobarse la campaña', async () => {
    state.blockedFindMany.mockResolvedValue([{ e164: '+34651234567' }]);

    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });

    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(result.excludedLate).toBe(1);
    // Y queda por qué, en la propia fila: "no se le escribió" hay que
    // poder demostrarlo.
    expect(state.memberUpdate.mock.calls[0][0].data).toEqual({
      state: 'excluded',
      excludedReason: 'suppressed',
    });
  });

  it('NO le escribe a quien recibió otro mensaje nuestro mientras tanto', async () => {
    state.outboundFindMany.mockResolvedValue([{ toE164: '+34651234567', sentAt: daysAgo(2) }]);
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(state.memberUpdate.mock.calls[0][0].data.excludedReason).toBe('contacted_recently');
  });

  it('NO le escribe a quien se le caducó la base legal entre medias', async () => {
    state.memberFindMany.mockResolvedValue([
      { ...MEMBER, contact: { ...MEMBER.contact, legalBasisCapturedAt: monthsAgo(30) } },
    ]);
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(result.excludedLate).toBe(1);
  });

  it('la supresión se consulta por SUSCRIPCIÓN, no globalmente', async () => {
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(state.blockedFindMany.mock.calls[0][0].where.subscriptionId).toBe('sub_1');
  });

  it('un excluido tardío NO cuenta como enviado ni como fallido', async () => {
    state.blockedFindMany.mockResolvedValue([{ e164: '+34651234567' }]);
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(result).toMatchObject({ sent: 0, failed: 0, excludedLate: 1 });
  });
});

// ===========================================================================
// 3. El resto
// ===========================================================================
describe('sendApprovedCampaign — el envío', () => {
  it('saluda con el nombre de pila, no con el apellido — un apellido suena a carta del banco', async () => {
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    const template = mockState.sendTemplate.mock.calls[0][3];
    expect(template.bodyParams[0]).toBe(' García');
    expect(template.bodyParams[1]).toBe('Fontanería Aurora');
  });

  it('un contacto sin nombre no deja "Hola , te escribimos": el espacio va dentro del parámetro', async () => {
    state.memberFindMany.mockResolvedValue([{ ...MEMBER, contact: { ...MEMBER.contact, name: null } }]);
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(mockState.sendTemplate.mock.calls[0][3].bodyParams[0]).toBe('');
  });

  it('apunta el envío en el libro mayor con la categoría correcta de la plantilla', async () => {
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(mockState.recordSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productCode: 'recall',
        channel: 'whatsapp',
        kind: 'template',
        // open_quote es UTILITY: es el seguimiento de una transacción concreta.
        category: 'UTILITY',
        templateName: 'recovery_open_quote',
        toE164: '+34651234567',
        ok: true,
      }),
    );
  });

  it('un envío fallido se apunta igual y marca al miembro, sin abortar la campaña', async () => {
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'rate limited', code: 131048 });
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(state.memberUpdate.mock.calls[0][0].data).toMatchObject({ state: 'failed', error: 'rate limited' });
    expect(mockState.recordSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, error: 'rate limited' }),
    );
  });

  it('marca el presupuesto como perseguido para que no vuelva a salir en el disparador', async () => {
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(state.quoteUpdateMany).toHaveBeenCalledWith({
      where: { clientId: 'client_1', contactId: 'contact_1', status: 'open' },
      data: { lastFollowedUpAt: NOW },
    });
  });

  it('NO marca presupuestos cuando el disparador es otro', async () => {
    state.campaignFindUnique.mockResolvedValue({ ...APPROVED_CAMPAIGN, trigger: 'dormant' });
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(state.quoteUpdateMany).not.toHaveBeenCalled();
  });

  it('sin remitente de WhatsApp no manda nada y lo dice', async () => {
    state.connectionFindFirst.mockResolvedValue(null);
    const result = await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(result.skipped).toBe('no_sender');
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('cierra la campaña cuando no queda nadie pendiente', async () => {
    state.memberCount.mockResolvedValue(0);
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(state.campaignUpdate.mock.calls[0][0].data).toMatchObject({ status: 'completed' });
  });

  it('NO la cierra si quedan miembros para la siguiente tanda', async () => {
    state.memberCount.mockResolvedValue(50);
    await sendApprovedCampaign(prisma, 'camp_1', { now: NOW });
    expect(state.campaignUpdate).not.toHaveBeenCalled();
  });
});

describe('draftCampaign', () => {
  beforeEach(() => {
    mockState.findRecoveryCandidates.mockResolvedValue({
      candidates: [
        {
          contactId: 'contact_1',
          e164: '+34651234567',
          name: 'García',
          trigger: 'open_quote',
          reason: 'presupuesto de 1.400 € de hace 34 días',
          serviceQuoteId: 'sq_1',
          amount: 1400,
        },
      ],
      excluded: [{ contactId: 'c_2', e164: '+34600000000', trigger: 'open_quote', reason: 'suppressed' }],
    });
    state.campaignCreate.mockResolvedValue({ id: 'camp_1' });
  });

  it('nace SIEMPRE en borrador — no hay forma de crearla ya aprobada', async () => {
    await draftCampaign(prisma, {
      clientId: 'client_1',
      subscriptionId: 'sub_1',
      trigger: 'open_quote',
      now: NOW,
    });
    const data = state.campaignCreate.mock.calls[0][0].data;
    expect(data.status).toBe('draft');
    expect(data.approvedAt).toBeUndefined();
    expect(data.approvedByOperatorId).toBeUndefined();
  });

  it('CONGELA la lista con el motivo que verá quien apruebe', async () => {
    await draftCampaign(prisma, {
      clientId: 'client_1',
      subscriptionId: 'sub_1',
      trigger: 'open_quote',
      now: NOW,
    });
    expect(state.campaignCreate.mock.calls[0][0].data.members.create).toEqual([
      {
        contactId: 'contact_1',
        e164: '+34651234567',
        reason: 'presupuesto de 1.400 € de hace 34 días',
        state: 'pending',
        serviceQuoteId: 'sq_1',
      },
    ]);
  });

  it('no crea una campaña vacía: un borrador sin nadie gasta la atención de quien revisa', async () => {
    mockState.findRecoveryCandidates.mockResolvedValue({ candidates: [], excluded: [] });
    const result = await draftCampaign(prisma, {
      clientId: 'client_1',
      subscriptionId: 'sub_1',
      trigger: 'open_quote',
      now: NOW,
    });
    expect(result).toBeNull();
    expect(state.campaignCreate).not.toHaveBeenCalled();
  });
});

describe('approveCampaign', () => {
  it('aprueba desde borrador y sella quién y cuándo', async () => {
    state.campaignUpdateMany.mockResolvedValue({ count: 1 });
    await expect(approveCampaign(prisma, 'camp_1', 'op_1', NOW)).resolves.toEqual({ ok: true });
    expect(state.campaignUpdateMany.mock.calls[0][0]).toEqual({
      // El status en el WHERE, no solo comprobado antes: dos operadores
      // pulsando a la vez no pueden dejar dos sellos sobre la misma.
      where: { id: 'camp_1', status: 'draft' },
      data: { status: 'approved', approvedByOperatorId: 'op_1', approvedAt: NOW },
    });
  });

  it('distingue "no existe" de "ya no está en borrador"', async () => {
    state.campaignUpdateMany.mockResolvedValue({ count: 0 });

    state.campaignFindUnique.mockResolvedValue({ id: 'camp_1' });
    await expect(approveCampaign(prisma, 'camp_1', 'op_1', NOW)).resolves.toEqual({
      ok: false,
      reason: 'not_draft',
    });

    state.campaignFindUnique.mockResolvedValue(null);
    await expect(approveCampaign(prisma, 'camp_x', 'op_1', NOW)).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
