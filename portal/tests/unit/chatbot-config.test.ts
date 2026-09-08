// =============================================================================
// Fase 1.1 — unit tests para src/lib/chatbot-config.ts.
//
// Lo que de verdad hay que proteger aquí no es "devuelve un JSON", sino las
// tres reglas que hacen que el bot no diga tonterías: solo configuración
// aprobada, defaults del catálogo cuando la tarifa oculta un paso, y un
// payload corrupto degradado en vez de propagado al prompt.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  stepFindMany: vi.fn(),
}));

const prismaMock = {
  chatbotClient: { findUnique: (...a: unknown[]) => mockState.clientFindUnique(...a) },
  chatbotConfigStep: { findMany: (...a: unknown[]) => mockState.stepFindMany(...a) },
} as unknown as Parameters<typeof import('@/lib/chatbot-config').buildBotConfig>[0];

import { buildBotConfig, buildChatbotContext, computeConfigVersion } from '@/lib/chatbot-config';

const PERFIL_VALIDO = {
  vertical: 'clinica',
  nombre_comercial: 'Clínica Orly',
  idiomas: ['ES'],
  idioma_por_defecto: 'ES',
};

const MENSAJES_VALIDO = {
  mensaje_bienvenida: '¡Bienvenido a Clínica Orly!',
  mensaje_despedida: 'Hasta pronto',
  prompts_sugeridos: ['Pedir cita'],
};

const SERVICIOS_VALIDO = {
  servicios: [
    { nombre: 'Limpieza dental', descripcion: 'Higiene completa', precio_tipo: 'fijo', precio_valor: 60 },
  ],
};

beforeEach(() => {
  mockState.clientFindUnique.mockReset().mockResolvedValue({ tier: 'pro' });
  mockState.stepFindMany.mockReset().mockResolvedValue([]);
});

describe('buildBotConfig — qué se sirve', () => {
  it('solo lee versiones aprobadas (activeForBot) del producto chatbot', async () => {
    await buildBotConfig(prismaMock, 'c1');
    expect(mockState.stepFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'c1', productCode: 'chatbot', activeForBot: true },
      }),
    );
  });

  it('devuelve los nueve bloques del bot, nunca undefined', async () => {
    const config = await buildBotConfig(prismaMock, 'c1');
    for (const key of [
      'perfil', 'personalidad', 'servicios', 'faq', 'horario',
      'captacion', 'derivacion', 'mensajes', 'cumplimiento',
    ] as const) {
      expect(config[key]).toBeDefined();
    }
  });

  it('sirve el payload real de un paso aprobado', async () => {
    mockState.stepFindMany.mockResolvedValue([
      { stepKey: '1', payload: PERFIL_VALIDO },
      { stepKey: '9', payload: MENSAJES_VALIDO },
    ]);
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.perfil).toMatchObject({ nombre_comercial: 'Clínica Orly' });
    expect(config.mensajes).toMatchObject({ mensaje_bienvenida: '¡Bienvenido a Clínica Orly!' });
  });

  it('no incluye los pasos 8, 11 ni 12 — no describen el comportamiento del bot', async () => {
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config).not.toHaveProperty('canales');
    expect(config).not.toHaveProperty('pruebas');
    expect(config).not.toHaveProperty('integraciones');
  });
});

describe('buildBotConfig — visibilidad por tier', () => {
  it('un cliente starter recibe el default del catálogo en servicios y derivación, no vacío', async () => {
    mockState.clientFindUnique.mockResolvedValue({ tier: 'starter' });
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '3', payload: SERVICIOS_VALIDO }]);

    const config = await buildBotConfig(prismaMock, 'c1');

    // La regla de precios que protege al bot de improvisar tarifas.
    expect(config.servicios).toMatchObject({ precio_tipo: 'consultar', servicios: [] });
    expect(config.derivacion).toMatchObject({ fallback_sin_respuesta: 'derivar' });
  });

  it('un cliente pro sí recibe sus servicios reales', async () => {
    mockState.clientFindUnique.mockResolvedValue({ tier: 'pro' });
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '3', payload: SERVICIOS_VALIDO }]);
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.servicios).toMatchObject(SERVICIOS_VALIDO);
  });

  it('un paso que la tarifa oculta NO cuenta como pendiente — el cliente no puede rellenarlo', async () => {
    mockState.clientFindUnique.mockResolvedValue({ tier: 'starter' });
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.readiness.missingRequired).not.toContain('3');
    expect(config.readiness.missingRequired).not.toContain('7');
  });

  it('para un cliente pro, esos mismos pasos sin aprobar sí cuentan como pendientes', async () => {
    mockState.clientFindUnique.mockResolvedValue({ tier: 'pro' });
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.readiness.missingRequired).toContain('3');
    expect(config.readiness.missingRequired).toContain('7');
  });
});

describe('buildBotConfig — readiness', () => {
  it('un cliente sin nada aprobado devuelve ready:false con la lista de lo que falta, no un error', async () => {
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.readiness.ready).toBe(false);
    expect(config.readiness.missingRequired.length).toBeGreaterThan(0);
  });

  it('un paso aprobado deja de aparecer como pendiente', async () => {
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '1', payload: PERFIL_VALIDO }]);
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.readiness.missingRequired).not.toContain('1');
  });
});

describe('buildBotConfig — payload corrupto', () => {
  it('degrada al default del catálogo en vez de propagar basura al prompt', async () => {
    mockState.stepFindMany.mockResolvedValue([
      { stepKey: '1', payload: { nombre_comercial: 42, idiomas: 'no es una lista' } },
    ]);
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.perfil).toEqual({});
    expect(config.readiness.missingRequired).toContain('1');
  });

  it('un payload nulo no rompe nada', async () => {
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '1', payload: null }]);
    const config = await buildBotConfig(prismaMock, 'c1');
    expect(config.perfil).toEqual({});
  });
});

describe('configVersion', () => {
  it('es estable entre dos llamadas sin cambios', async () => {
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '1', payload: PERFIL_VALIDO }]);
    const a = await buildBotConfig(prismaMock, 'c1');
    const b = await buildBotConfig(prismaMock, 'c1');
    expect(a.configVersion).toBe(b.configVersion);
  });

  it('cambia cuando se aprueba una versión distinta de un paso', async () => {
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '1', payload: PERFIL_VALIDO }]);
    const before = await buildBotConfig(prismaMock, 'c1');

    mockState.stepFindMany.mockResolvedValue([
      { stepKey: '1', payload: { ...PERFIL_VALIDO, nombre_comercial: 'Clínica Orly Centro' } },
    ]);
    const after = await buildBotConfig(prismaMock, 'c1');

    expect(after.configVersion).not.toBe(before.configVersion);
  });

  it('cambia cuando cambia el tier, porque cambian los defaults aplicados', async () => {
    mockState.clientFindUnique.mockResolvedValue({ tier: 'pro' });
    const pro = await buildBotConfig(prismaMock, 'c1');
    mockState.clientFindUnique.mockResolvedValue({ tier: 'starter' });
    const starter = await buildBotConfig(prismaMock, 'c1');
    expect(pro.configVersion).not.toBe(starter.configVersion);
  });

  it('no depende del orden de las claves — mismo contenido, misma versión', () => {
    expect(computeConfigVersion({ a: 1, b: { x: 1, y: 2 } })).toBe(
      computeConfigVersion({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });
});

describe('buildChatbotContext — compatibilidad con lo que ya consumía n8n', () => {
  beforeEach(() => {
    mockState.clientFindUnique.mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly', tier: 'pro' });
  });

  it('mantiene los cuatro campos de siempre cuando el paso 9 está aprobado', async () => {
    mockState.stepFindMany.mockResolvedValue([{ stepKey: '9', payload: MENSAJES_VALIDO }]);
    const context = await buildChatbotContext(prismaMock, 'c1');
    expect(context.businessName).toBe('Clínica Orly');
    expect(context.welcomeMessage).toBe('¡Bienvenido a Clínica Orly!');
    expect(context.farewellMessage).toBe('Hasta pronto');
    expect(context.suggestedPrompts).toEqual(['Pedir cita']);
  });

  it('mantiene los mismos valores por defecto de antes cuando no hay paso 9', async () => {
    const context = await buildChatbotContext(prismaMock, 'c1');
    expect(context.welcomeMessage).toBe('¡Hola! ¿En qué puedo ayudarte?');
    expect(context.farewellMessage).toBeNull();
    expect(context.suggestedPrompts).toEqual([]);
  });

  it('cae a nombre genérico cuando el cliente no tiene nombre comercial ni nombre', async () => {
    mockState.clientFindUnique.mockResolvedValue({ companyName: null, name: null, tier: null });
    const context = await buildChatbotContext(prismaMock, 'c1');
    expect(context.businessName).toBe('nuestro negocio');
  });

  it('añade la configuración completa junto a los campos antiguos', async () => {
    const context = await buildChatbotContext(prismaMock, 'c1');
    expect(context.config.configVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(context.config.tier).toBe('pro');
  });
});
