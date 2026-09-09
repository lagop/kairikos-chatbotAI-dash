// =============================================================================
// Fase 4 — unit tests para src/lib/cross-product-prefill.ts.
//
// La regla que hay que fijar es una: **nunca pisa lo que el cliente ya
// escribió**. Cambiarle una respuesta suya por lo que dijo en otro sitio,
// sin avisar, es peor que no sugerir nada.
//
// Y que solo se lea de pasos APROBADOS: sugerir a partir de un borrador
// que ningún operador ha revisado propagaría a otro producto algo que ni
// el bot está usando.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  suggestSeoProfileFields,
  suggestLeadQualificationFields,
  suggestionsToValues,
} from '@/lib/cross-product-prefill';

const findFirst = vi.fn();
const prisma = { chatbotConfigStep: { findFirst: (...a: unknown[]) => findFirst(...a) } } as unknown as PrismaClient;

beforeEach(() => {
  findFirst.mockReset().mockResolvedValue(null);
  mockState.logError.mockReset();
});

describe('suggestSeoProfileFields', () => {
  const perfil = {
    payload: { nombre_comercial: 'Peluquería Aurora', vertical: 'clinica', web: 'https://aurora.example' },
  };

  it('sin wizard aprobado no sugiere nada', async () => {
    expect(await suggestSeoProfileFields(prisma, 'c1', null)).toEqual([]);
  });

  it('solo lee pasos aprobados por un operador', async () => {
    await suggestSeoProfileFields(prisma, 'c1', null);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activeForBot: true }) }),
    );
  });

  it('usa el stepKey del catálogo, que es un número y no un nombre', async () => {
    await suggestSeoProfileFields(prisma, 'c1', null);
    expect(findFirst.mock.calls[0][0].where.stepKey).toBe('1');
  });

  it('propone la web y una primera descripción cuando el perfil está vacío', async () => {
    findFirst.mockResolvedValue(perfil);
    const suggestions = await suggestSeoProfileFields(prisma, 'c1', {
      businessDescription: null,
      siteUrl: null,
    });
    expect(suggestions).toEqual([
      { field: 'siteUrl', value: 'https://aurora.example', sourceLabel: expect.any(String) },
      { field: 'businessDescription', value: 'Peluquería Aurora, clinica.', sourceLabel: expect.any(String) },
    ]);
  });

  it('NO pisa lo que el cliente ya había escrito', async () => {
    findFirst.mockResolvedValue(perfil);
    const suggestions = await suggestSeoProfileFields(prisma, 'c1', {
      businessDescription: 'Lo mío, escrito por mí',
      siteUrl: 'https://la-de-verdad.example',
    });
    expect(suggestions).toEqual([]);
  });

  it('un sector «otro» no se mete en la descripción', async () => {
    findFirst.mockResolvedValue({ payload: { nombre_comercial: 'Aurora', vertical: 'otro' } });
    const suggestions = await suggestSeoProfileFields(prisma, 'c1', { businessDescription: null, siteUrl: null });
    expect(suggestions[0].value).toBe('Aurora.');
  });

  it('nunca lanza: es un adorno de una pantalla que tiene que abrir igual', async () => {
    findFirst.mockRejectedValue(new Error('db down'));
    expect(await suggestSeoProfileFields(prisma, 'c1', null)).toEqual([]);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('suggestLeadQualificationFields', () => {
  it('hereda el email de aviso del paso 6 del chatbot', async () => {
    findFirst.mockResolvedValue({ payload: { email_notificacion: 'ventas@aurora.example' } });
    expect(await suggestLeadQualificationFields(prisma, 'c1', { emailAviso: null })).toEqual([
      { field: 'emailAviso', value: 'ventas@aurora.example', sourceLabel: expect.any(String) },
    ]);
  });

  it('con varios separados por comas se queda con el primero', async () => {
    // El campo destino solo admite uno; pegar la lista lo haría inválido.
    findFirst.mockResolvedValue({ payload: { email_notificacion: 'a@x.example, b@x.example' } });
    const suggestions = await suggestLeadQualificationFields(prisma, 'c1', { emailAviso: null });
    expect(suggestions[0].value).toBe('a@x.example');
  });

  it('NO pisa el que ya tenía puesto', async () => {
    findFirst.mockResolvedValue({ payload: { email_notificacion: 'ventas@aurora.example' } });
    expect(await suggestLeadQualificationFields(prisma, 'c1', { emailAviso: 'el.mio@aurora.example' })).toEqual([]);
  });

  it('lee el paso 6', async () => {
    await suggestLeadQualificationFields(prisma, 'c1', { emailAviso: null });
    expect(findFirst.mock.calls[0][0].where.stepKey).toBe('6');
  });
});

describe('suggestionsToValues', () => {
  it('las convierte en algo que un formulario puede usar', () => {
    expect(
      suggestionsToValues([{ field: 'emailAviso', value: 'a@x.example', sourceLabel: 'x' }]),
    ).toEqual({ emailAviso: 'a@x.example' });
  });
});
