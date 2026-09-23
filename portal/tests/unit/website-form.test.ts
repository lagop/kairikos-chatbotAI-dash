// =============================================================================
// Producto Web, Fase 1 — unit tests del formulario de la web publicada.
//
// Tres cosas que se fijan aquí:
//
// 1. Los DOS destinos. Con `leads` contratado el mensaje entra en la bandeja;
//    sin él, correo. No se mete un lead en una bandeja que el cliente no ha
//    comprado, y tampoco se pierde el contacto por no haberla comprado.
// 2. El tope por hora. Un formulario público sin freno es un bot dejando cien
//    basuras en la bandeja del cliente en un minuto.
// 3. Que un contacto inservible se rechace ANTES de avisar a nadie: un aviso
//    con un "hola" por toda información solo sirve para frustrar.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  hasLeadsInbox: vi.fn(),
  sendEmail: vi.fn(),
  findWebsite: vi.fn(),
  countLeads: vi.fn(),
  createLead: vi.fn(),
  createAudit: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/leads', () => ({ hasLeadsInboxAccess: (...a: unknown[]) => mockState.hasLeadsInbox(...a) }));
vi.mock('@/lib/leads-email', () => ({ sendNewLeadEmail: (...a: unknown[]) => mockState.sendEmail(...a) }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import { handleWebsiteFormSubmission, classifyContact, isFormToken, createFormToken } from '@/lib/website-form';
import type { PrismaClient } from '@prisma/client';

const prisma = {
  clientWebsite: { findUnique: (...a: unknown[]) => mockState.findWebsite(...a) },
  lead: { count: (...a: unknown[]) => mockState.countLeads(...a), create: (...a: unknown[]) => mockState.createLead(...a) },
  leadAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
  $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      lead: { create: (...a: unknown[]) => mockState.createLead(...a) },
      leadAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
    }),
} as unknown as PrismaClient;

const SUBMISSION = { name: 'Ana', contact: '600112233', message: 'Necesito presupuesto' };

beforeEach(() => {
  mockState.hasLeadsInbox.mockReset().mockResolvedValue(true);
  mockState.sendEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.findWebsite.mockReset().mockResolvedValue({
    id: 'w1',
    clientId: 'client-1',
    tenantId: null,
    businessName: 'Fontanería Ejemplo',
    client: { email: 'duenyo@negocio.es', name: 'Fontanería Ejemplo' },
  });
  mockState.countLeads.mockReset().mockResolvedValue(0);
  mockState.createLead.mockReset().mockResolvedValue({ id: 'lead-1', clientId: 'client-1', tenantId: null });
  mockState.createAudit.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
});

describe('classifyContact', () => {
  it('distingue email de teléfono', () => {
    expect(classifyContact('ana@ejemplo.es')).toEqual({ phone: null, email: 'ana@ejemplo.es' });
    expect(classifyContact('600 11 22 33')).toEqual({ phone: '600112233', email: null });
    expect(classifyContact('+34600112233')).toEqual({ phone: '+34600112233', email: null });
  });

  it('lo que no sirve para responder no vale', () => {
    expect(classifyContact('hola')).toEqual({ phone: null, email: null });
    expect(classifyContact('123')).toEqual({ phone: null, email: null });
    expect(classifyContact('arroba@sinpunto')).toEqual({ phone: null, email: null });
  });
});

describe('isFormToken', () => {
  it('acepta el testigo que genera el sistema', () => {
    expect(isFormToken(createFormToken())).toBe(true);
  });

  it('rechaza basura sin tocar la base de datos', () => {
    expect(isFormToken('abc')).toBe(false);
    expect(isFormToken('../admin')).toBe(false);
    expect(isFormToken('Z'.repeat(48))).toBe(false);
  });
});

describe('handleWebsiteFormSubmission', () => {
  it('con leads contratado entra en la bandeja del cliente', async () => {
    const result = await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION);
    expect(result).toEqual({ ok: true, destination: 'leads' });
    expect(mockState.createLead).toHaveBeenCalled();
    expect(mockState.sendEmail).not.toHaveBeenCalled();
  });

  it('el lead nace como inbound por web, no como prospección', async () => {
    await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION);
    expect(mockState.createLead.mock.calls[0][0].data).toMatchObject({
      source: 'inbound',
      channel: 'web',
      status: 'nuevo',
      contactPhone: '600112233',
    });
  });

  it('sin leads contratado se avisa por correo y NO se crea lead', async () => {
    mockState.hasLeadsInbox.mockResolvedValue(false);
    const result = await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION);
    expect(result).toEqual({ ok: true, destination: 'email' });
    expect(mockState.createLead).not.toHaveBeenCalled();
    expect(mockState.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'duenyo@negocio.es' }));
  });

  it('un correo que no sale no se le devuelve al visitante como error', async () => {
    mockState.hasLeadsInbox.mockResolvedValue(false);
    mockState.sendEmail.mockResolvedValue({ ok: false, error: 'The domain is invalid' });
    const result = await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION);
    expect(result.ok).toBe(true);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('un testigo desconocido no dice nada más que "no existe"', async () => {
    mockState.findWebsite.mockResolvedValue(null);
    expect(await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('un contacto inservible se rechaza antes de avisar a nadie', async () => {
    const result = await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), { ...SUBMISSION, contact: 'hola' });
    expect(result).toEqual({ ok: false, error: 'invalid' });
    expect(mockState.createLead).not.toHaveBeenCalled();
    expect(mockState.sendEmail).not.toHaveBeenCalled();
  });

  it('pasado el tope por hora no se acepta nada más', async () => {
    mockState.countLeads.mockResolvedValue(20);
    const result = await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), SUBMISSION);
    expect(result).toEqual({ ok: false, error: 'rate_limited' });
    expect(mockState.createLead).not.toHaveBeenCalled();
  });

  it('un mensaje vacío no deja el aviso sin asunto', async () => {
    await handleWebsiteFormSubmission(prisma, 'a'.repeat(48), { ...SUBMISSION, message: '' });
    expect(mockState.createLead.mock.calls[0][0].data.summary).toContain('Contacto desde su web');
  });
});
