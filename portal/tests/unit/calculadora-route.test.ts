// =============================================================================
// A5 — POST /api/public/calculadora.
//
// Es una ruta pública sin sesión y sin freno de gasto (calcular es gratis),
// así que lo que hay que fijar es distinto de lo habitual:
//
// 1. Que el número salga del sector elegido y no del fontanero por defecto.
//    Es exactamente el fallo que se vio en producción con el informe: 300 €
//    de encargo medio para una peluquería.
// 2. Que el cálculo se devuelva aunque el visitante NO deje contacto. Cobrar
//    el número con un email espanta a más gente de la que captura.
// 3. Que un fallo guardando el contacto no le quite el número a quien ya lo
//    ha pedido: el lead es nuestro problema, no suyo.
// 4. Que el campo trampa corte antes de tocar la base de datos.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  createCalculatorLead: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

vi.mock('@/lib/prisma', () => ({
  prisma: { calculatorLead: { create: (...a: unknown[]) => mockState.createCalculatorLead(...a) } },
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.5' }),
  } as unknown as Parameters<typeof import('@/app/api/public/calculadora/route').POST>[0];
}

beforeEach(() => {
  mockState.createCalculatorLead.mockReset().mockResolvedValue({ id: 'lead_1' });
  mockState.logError.mockReset();
});

describe('POST /api/public/calculadora', () => {
  it('el encargo medio sale del sector, no del fontanero por defecto', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');

    const fontaneria = await (await POST(makeRequest({ sector: 'fontaneria', llamadasPerdidas: 3 }))).json();
    const peluqueria = await (await POST(makeRequest({ sector: 'peluqueria', llamadasPerdidas: 3 }))).json();

    expect(fontaneria.supuestos.averageJobValue).toBeGreaterThan(peluqueria.supuestos.averageJobValue);
    expect(fontaneria.anual).toBeGreaterThan(peluqueria.anual);
  });

  it('un sector inventado cae en "otro" en vez de reventar', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    const res = await POST(makeRequest({ sector: 'astronauta', llamadasPerdidas: 3 }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('da el número sin pedir nada a cambio: sin contacto no se guarda ningún lead', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    const res = await POST(makeRequest({ sector: 'fontaneria', llamadasPerdidas: 5 }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.anual).toBeGreaterThan(0);
    expect(mockState.createCalculatorLead).not.toHaveBeenCalled();
  });

  it('cuando deja contacto, se guarda como lead', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    await POST(makeRequest({ sector: 'fontaneria', llamadasPerdidas: 5, contacto: '600123123', negocio: 'Fontanería Ana' }));

    expect(mockState.createCalculatorLead).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contact: '600123123', businessName: 'Fontanería Ana' }),
      }),
    );
    // La IP se guarda en hash, nunca en claro.
    const { data } = mockState.createCalculatorLead.mock.calls[0][0];
    expect(data.ipHash).not.toContain('203.0.113.5');
  });

  it('si falla guardar el lead, el visitante ve su número igual', async () => {
    mockState.createCalculatorLead.mockRejectedValueOnce(new Error('db_down'));
    const { POST } = await import('@/app/api/public/calculadora/route');
    const res = await POST(makeRequest({ sector: 'fontaneria', llamadasPerdidas: 5, contacto: '600123123' }));

    expect(res.status).toBe(200);
    expect((await res.json()).anual).toBeGreaterThan(0);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('el campo trampa corta antes de tocar la base de datos', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    const res = await POST(
      makeRequest({ sector: 'fontaneria', llamadasPerdidas: 5, contacto: 'x@y.es', website: 'https://spam.example' }),
    );
    expect(res.status).toBe(400);
    expect(mockState.createCalculatorLead).not.toHaveBeenCalled();
  });

  it('un cuerpo sin llamadas es inválido, no un cero silencioso', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    expect((await POST(makeRequest({ sector: 'fontaneria' }))).status).toBe(400);
  });

  it('las cifras absurdas se recortan antes de multiplicar: nadie pierde mil llamadas a la semana', async () => {
    const { POST } = await import('@/app/api/public/calculadora/route');
    const body = await (
      await POST(makeRequest({ sector: 'fontaneria', llamadasPerdidas: 100000, encargoMedio: 9999999 }))
    ).json();

    expect(body.supuestos.missedCallsPerWeek).toBeLessThan(1000);
    expect(Number.isFinite(body.anual)).toBe(true);
  });
});
