// =============================================================================
// Fase 1.2 — unit tests para src/lib/chatbot-conversation.ts.
//
// Lo importante aquí no es la respuesta del modelo (eso se prueba en
// chatbot-reply-ai.test.ts) sino qué queda escrito: los dos turnos una sola
// vez, el del cliente también cuando la IA falla, y la derivación reflejada
// en el `outcome` de la conversación.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  buildChatbotContext: vi.fn(),
  generateBotReply: vi.fn(),
  retrieveKnowledge: vi.fn(),
}));

vi.mock('@/lib/chatbot-config', () => ({
  buildChatbotContext: (...a: unknown[]) => mockState.buildChatbotContext(...a),
}));

vi.mock('@/lib/chatbot-reply-ai', () => ({
  generateBotReply: (...a: unknown[]) => mockState.generateBotReply(...a),
}));

// Fase 3 — la base de conocimiento se consulta en cada turno. Aquí se
// mockea para que estos tests sigan siendo sobre qué queda escrito, no
// sobre la recuperación (que tiene los suyos en chatbot-knowledge.test.ts).
vi.mock('@/lib/chatbot-knowledge', () => ({
  retrieveKnowledge: (...a: unknown[]) => mockState.retrieveKnowledge(...a),
}));

import { replyToIncomingMessage, readTranscriptTurns, dropDanglingRetry } from '@/lib/chatbot-conversation';

const prismaMock = {
  chatbotConversation: {
    findUnique: (...a: unknown[]) => mockState.findUnique(...a),
    findFirst: (...a: unknown[]) => mockState.findFirst(...a),
    create: (...a: unknown[]) => mockState.create(...a),
    update: (...a: unknown[]) => mockState.update(...a),
  },
} as unknown as Parameters<typeof replyToIncomingMessage>[0];

const NOW = new Date('2026-09-07T10:00:00Z');

const BASE = {
  clientId: 'c1',
  tenantId: 't1',
  channel: 'whatsapp',
  key: { kind: 'inactivity' as const, sessionPrefix: 'whatsapp-34600-' },
  message: 'quiero pedir cita',
  now: NOW,
};

function transcriptOf(call: { data: { transcript: unknown } }) {
  return call.data.transcript as Array<{ role: string; content: string }>;
}

beforeEach(() => {
  mockState.findUnique.mockReset().mockResolvedValue(null);
  mockState.findFirst.mockReset().mockResolvedValue(null);
  mockState.create.mockReset().mockResolvedValue({ id: 'conv_new' });
  mockState.update.mockReset().mockResolvedValue({ id: 'conv_existing' });
  mockState.buildChatbotContext.mockReset().mockResolvedValue({
    businessName: 'Clínica Orly',
    welcomeMessage: 'Hola',
    farewellMessage: null,
    suggestedPrompts: [],
    config: { configVersion: 'v1', tier: 'pro' },
  });
  mockState.retrieveKnowledge.mockReset().mockResolvedValue([]);
  mockState.generateBotReply.mockReset().mockResolvedValue({
    ok: true, reply: 'Claro, ¿qué día te viene bien?', escalate: false, escalateReason: null,
  });
});

describe('readTranscriptTurns', () => {
  it('lee los turnos válidos e ignora la basura', () => {
    expect(readTranscriptTurns([
      { role: 'user', content: 'hola', at: 'x' },
      { role: 'system', content: 'no cuenta' },
      { role: 'assistant', content: 'buenas' },
      'suelto',
      { role: 'user' },
    ] as never)).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'buenas' },
    ]);
  });

  it('tolera un transcript nulo o que no sea lista', () => {
    expect(readTranscriptTurns(null)).toEqual([]);
    expect(readTranscriptTurns({ foo: 1 } as never)).toEqual([]);
  });
});

describe('replyToIncomingMessage — qué queda escrito', () => {
  it('escribe los dos turnos, en orden, en una sola operación', async () => {
    const result = await replyToIncomingMessage(prismaMock, BASE);

    expect(result).toMatchObject({ ok: true, conversationId: 'conv_new', reply: 'Claro, ¿qué día te viene bien?' });
    expect(mockState.create).toHaveBeenCalledTimes(1);
    expect(mockState.update).not.toHaveBeenCalled();

    const transcript = transcriptOf(mockState.create.mock.calls[0][0]);
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ role: 'user', content: 'quiero pedir cita' });
    expect(transcript[1]).toMatchObject({ role: 'assistant', content: 'Claro, ¿qué día te viene bien?' });
  });

  it('guarda el turno del cliente aunque la IA falle — el portal es el registro', async () => {
    mockState.generateBotReply.mockResolvedValue({ ok: false, error: 'anthropic_api_error:529' });

    const result = await replyToIncomingMessage(prismaMock, BASE);

    expect(result).toMatchObject({ ok: false, error: 'anthropic_api_error:529', conversationId: 'conv_new' });
    const transcript = transcriptOf(mockState.create.mock.calls[0][0]);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ role: 'user', content: 'quiero pedir cita' });
  });

  it('guarda el turno del cliente aunque no haya clave de IA configurada', async () => {
    mockState.generateBotReply.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });

    const result = await replyToIncomingMessage(prismaMock, BASE);

    expect(result).toMatchObject({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(transcriptOf(mockState.create.mock.calls[0][0])).toHaveLength(1);
  });

  it('marca la conversación como derivada cuando el motor lo pide', async () => {
    mockState.generateBotReply.mockResolvedValue({
      ok: true, reply: 'Te paso con una persona del equipo.', escalate: true, escalateReason: 'pregunta médica',
    });

    const result = await replyToIncomingMessage(prismaMock, BASE);

    expect(result).toMatchObject({ escalate: true, escalateReason: 'pregunta médica' });
    expect(mockState.create.mock.calls[0][0].data.outcome).toBe('escalated');
  });

  it('no toca el outcome cuando no hay derivación', async () => {
    await replyToIncomingMessage(prismaMock, BASE);
    expect(mockState.create.mock.calls[0][0].data.outcome).toBeNull();
  });
});

// Encontrado probando en real: tras un fallo del modelo, el turno del
// cliente queda guardado, y el reintento de n8n con el mismo mensaje lo
// duplicaba en el transcript.
describe('reintentos tras un fallo del modelo', () => {
  it('dropDanglingRetry quita el turno colgado solo si es idéntico y nadie lo contestó', () => {
    const colgado = [{ role: 'user', content: 'sí' }];
    expect(dropDanglingRetry(colgado, 'sí')).toEqual([]);
    expect(dropDanglingRetry(colgado, 'otra cosa')).toEqual(colgado);

    // Ya contestado: un "sí" repetido es un mensaje nuevo de verdad.
    const contestado = [{ role: 'user', content: 'sí' }, { role: 'assistant', content: '¿cuándo?' }];
    expect(dropDanglingRetry(contestado, 'sí')).toEqual(contestado);
    expect(dropDanglingRetry([], 'sí')).toEqual([]);
  });

  it('el reintento no duplica el turno del cliente en el transcript', async () => {
    mockState.findFirst.mockResolvedValue({
      id: 'conv_existing',
      startedAt: new Date('2026-09-07T09:59:00Z'),
      duration: 30,
      outcome: null,
      // Lo que dejó el intento fallido: el turno del cliente, sin respuesta.
      transcript: [{ role: 'user', content: 'quiero pedir cita', at: 'x' }],
    });

    await replyToIncomingMessage(prismaMock, BASE);

    const transcript = transcriptOf(mockState.update.mock.calls[0][0]);
    expect(transcript).toHaveLength(2);
    expect(transcript.filter((t) => t.role === 'user')).toHaveLength(1);
  });

  it('el turno colgado tampoco se le manda dos veces al modelo', async () => {
    mockState.findFirst.mockResolvedValue({
      id: 'conv_existing',
      startedAt: new Date('2026-09-07T09:59:00Z'),
      duration: 30,
      outcome: null,
      transcript: [{ role: 'assistant', content: 'hola', at: 'x' }, { role: 'user', content: 'quiero pedir cita', at: 'x' }],
    });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.generateBotReply).toHaveBeenCalledWith(
      expect.objectContaining({ history: [{ role: 'assistant', content: 'hola' }] }),
    );
  });
});

describe('replyToIncomingMessage — continuidad de la conversación', () => {
  const openConversation = {
    id: 'conv_existing',
    startedAt: new Date('2026-09-07T09:30:00Z'),
    duration: 60,
    outcome: null,
    transcript: [{ role: 'user', content: 'hola', at: 'x' }, { role: 'assistant', content: '¿en qué te ayudo?', at: 'x' }],
  };

  it('continúa la conversación abierta y le pasa el historial al motor', async () => {
    mockState.findFirst.mockResolvedValue(openConversation);

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.generateBotReply).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: '¿en qué te ayudo?' }],
        message: 'quiero pedir cita',
      }),
    );
    expect(mockState.update).toHaveBeenCalledTimes(1);
    expect(mockState.create).not.toHaveBeenCalled();
    expect(transcriptOf(mockState.update.mock.calls[0][0])).toHaveLength(4);
  });

  it('abre una conversación nueva pasadas las 6 horas de inactividad', async () => {
    mockState.findFirst.mockResolvedValue({
      ...openConversation,
      startedAt: new Date('2026-09-07T02:00:00Z'),
      duration: 60,
    });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.create).toHaveBeenCalledTimes(1);
    expect(mockState.update).not.toHaveBeenCalled();
    // Historial en blanco: es una conversación distinta, no la de esta madrugada.
    expect(mockState.generateBotReply).toHaveBeenCalledWith(expect.objectContaining({ history: [] }));
  });

  it('el widget web se identifica por su propio sessionId, no por inactividad', async () => {
    mockState.findUnique.mockResolvedValue(null);

    await replyToIncomingMessage(prismaMock, {
      ...BASE,
      channel: 'web',
      key: { kind: 'exact', externalSessionId: 'sess_abc' },
    });

    expect(mockState.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_externalSessionId: { clientId: 'c1', externalSessionId: 'sess_abc' } },
      }),
    );
    expect(mockState.findFirst).not.toHaveBeenCalled();
    expect(mockState.create.mock.calls[0][0].data.externalSessionId).toBe('sess_abc');
  });

  it('la sesión nueva de un canal de mensajería lleva el prefijo del canal', async () => {
    await replyToIncomingMessage(prismaMock, BASE);
    expect(mockState.create.mock.calls[0][0].data.externalSessionId).toMatch(/^whatsapp-34600-\d+$/);
  });

  // Fase 1.5 — sin esto, los leads que crea el clasificador salían con
  // channel:null y el cliente veía "sin canal".
  it('guarda el canal de origen en la conversación nueva', async () => {
    await replyToIncomingMessage(prismaMock, BASE);
    expect(mockState.create.mock.calls[0][0].data.channel).toBe('whatsapp');
  });

  it('también lo rellena al continuar una conversación abierta antes de que existiera el campo', async () => {
    mockState.findFirst.mockResolvedValue({
      id: 'conv_existing',
      startedAt: new Date('2026-09-07T09:30:00Z'),
      duration: 60,
      outcome: null,
      transcript: [],
    });
    await replyToIncomingMessage(prismaMock, { ...BASE, channel: 'instagram' });
    expect(mockState.update.mock.calls[0][0].data.channel).toBe('instagram');
  });
});

// =============================================================================
// Fase 3 — traspaso a humano y base de conocimiento.
// =============================================================================

describe('replyToIncomingMessage — el bot se calla cuando hay un humano', () => {
  const takenConversation = {
    id: 'conv_existing',
    startedAt: new Date('2026-09-07T09:30:00Z'),
    duration: 60,
    outcome: 'escalated',
    transcript: [{ role: 'user', content: 'quiero hablar con alguien', at: 'x' }],
    handoffRequestedAt: new Date('2026-09-07T09:40:00Z'),
    handoffTakenAt: new Date('2026-09-07T09:45:00Z'),
    handoffClosedAt: null,
  };

  it('no llama al modelo, pero SÍ guarda lo que dijo el cliente', async () => {
    mockState.findFirst.mockResolvedValue(takenConversation);

    const result = await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.generateBotReply).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, skipped: true, reason: 'human_handoff', conversationId: 'conv_existing' });

    const transcript = transcriptOf(mockState.update.mock.calls[0][0]);
    expect(transcript).toHaveLength(2);
    expect(transcript[1]).toMatchObject({ role: 'user', content: 'quiero pedir cita' });
  });

  it('mientras solo está PENDIENTE, el bot sigue contestando', async () => {
    // Nadie la ha tomado: callar al bot dejaría al cliente hablando solo.
    mockState.findFirst.mockResolvedValue({ ...takenConversation, handoffTakenAt: null });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.generateBotReply).toHaveBeenCalled();
  });

  it('devuelta al bot, vuelve a responder', async () => {
    mockState.findFirst.mockResolvedValue({
      ...takenConversation,
      handoffTakenAt: null,
      handoffClosedAt: new Date('2026-09-07T09:50:00Z'),
    });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.generateBotReply).toHaveBeenCalled();
  });
});

describe('replyToIncomingMessage — cuándo se estampa la derivación', () => {
  it('marca el momento en que el bot pide ayuda por primera vez', async () => {
    mockState.generateBotReply.mockResolvedValue({
      ok: true,
      reply: 'Te paso con una persona.',
      escalate: true,
      escalateReason: 'reclamación',
    });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.create.mock.calls[0][0].data).toMatchObject({
      outcome: 'escalated',
      handoffRequestedAt: NOW,
    });
  });

  it('no reescribe la marca en cada turno: la bandeja ordena por cuánto lleva esperando', async () => {
    const requestedAt = new Date('2026-09-07T09:31:00Z');
    mockState.findFirst.mockResolvedValue({
      id: 'conv_existing',
      startedAt: new Date('2026-09-07T09:30:00Z'),
      duration: 60,
      outcome: 'escalated',
      transcript: [],
      handoffRequestedAt: requestedAt,
      handoffTakenAt: null,
      handoffClosedAt: null,
    });
    mockState.generateBotReply.mockResolvedValue({
      ok: true,
      reply: 'Sigo esperando a un compañero.',
      escalate: true,
      escalateReason: 'reclamación',
    });

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.update.mock.calls[0][0].data.handoffRequestedAt).toEqual(requestedAt);
  });

  it('una conversación normal no queda marcada como derivada', async () => {
    await replyToIncomingMessage(prismaMock, BASE);
    expect(mockState.create.mock.calls[0][0].data.handoffRequestedAt).toBeNull();
  });
});

describe('replyToIncomingMessage — base de conocimiento', () => {
  it('busca material con el mensaje del cliente y se lo pasa al motor', async () => {
    mockState.retrieveKnowledge.mockResolvedValue([
      { documentTitle: 'Tarifas', content: 'El corte de caballero son 18 euros.' },
    ]);

    await replyToIncomingMessage(prismaMock, BASE);

    expect(mockState.retrieveKnowledge).toHaveBeenCalledWith(prismaMock, 'c1', 'quiero pedir cita');
    expect(mockState.generateBotReply).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledge: [{ documentTitle: 'Tarifas', content: 'El corte de caballero son 18 euros.' }],
      }),
    );
  });

  it('sin material, el motor recibe una lista vacía y responde igual', async () => {
    await replyToIncomingMessage(prismaMock, BASE);
    expect(mockState.generateBotReply).toHaveBeenCalledWith(expect.objectContaining({ knowledge: [] }));
  });
});
