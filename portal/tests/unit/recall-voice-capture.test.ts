// =============================================================================
// Fase 2b — tests de la captura por voz.
//
// Las dos cosas que no pueden fallar:
//
//   1. NADA SE GUARDA SIN CONFIRMAR. La nota de voz crea un borrador, y el
//      borrador solo se convierte en Job cuando el profesional dice que sí.
//   2. UN "SÍ" TARDÍO NO CONFIRMA NADA. Pasada la ventana, confirmar un
//      borrador que ya no se recuerda haber dictado crearía un trabajo
//      inventado con el importe de otro.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  fetchMediaBytes: vi.fn(),
  postAudioToWhisper: vi.fn(),
  isWhisperConfigured: vi.fn(),
  extractJobFromTranscript: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  fetchMediaBytes: (...a: unknown[]) => mockState.fetchMediaBytes(...a),
}));
vi.mock('@/lib/whisper', () => ({
  postAudioToWhisper: (...a: unknown[]) => mockState.postAudioToWhisper(...a),
  isWhisperConfigured: () => mockState.isWhisperConfigured(),
}));
vi.mock('@/lib/job-capture-ai', async () => {
  const actual = await vi.importActual<typeof import('@/lib/job-capture-ai')>('@/lib/job-capture-ai');
  // nextServiceDate se deja REAL: es la aritmética de fechas que el modelo
  // NO hace, y queremos verla ejecutarse de verdad.
  return { ...actual, extractJobFromTranscript: (...a: unknown[]) => mockState.extractJobFromTranscript(...a) };
});
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  captureVoiceNote,
  resolveDraftWithReply,
  confirmationIntent,
  confirmationCard,
  DRAFT_TTL_MINUTES,
} from '@/lib/recall-voice-capture';

const NOW = new Date('2026-09-15T12:00:00Z');

const state = {
  draftCreate: vi.fn(),
  draftFindFirst: vi.fn(),
  draftUpdate: vi.fn(),
  jobCreate: vi.fn(),
  quoteCreate: vi.fn(),
};

const prisma = {
  jobCaptureDraft: {
    create: (...a: unknown[]) => state.draftCreate(...a),
    findFirst: (...a: unknown[]) => state.draftFindFirst(...a),
    update: (...a: unknown[]) => state.draftUpdate(...a),
  },
  job: { create: (...a: unknown[]) => state.jobCreate(...a) },
  serviceQuote: { create: (...a: unknown[]) => state.quoteCreate(...a) },
} as unknown as PrismaClient;

/** El ejemplo canónico del documento, ya extraído. */
const GARCIA = {
  kind: 'job' as const,
  contactName: 'García',
  contactHint: 'calle Mayor 14',
  serviceType: 'cambio de termo eléctrico',
  amount: 340,
  currency: 'EUR',
  equipment: null,
  nextServiceMonths: 12,
  description: 'Cambio de termo eléctrico',
};

const CAPTURE_INPUT = {
  clientId: 'client_1',
  tenantId: 'tenant_1',
  subscriptionId: 'sub_1',
  mediaId: 'media_1',
  accessToken: 'token',
  now: NOW,
};

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  for (const fn of Object.values(mockState)) fn.mockReset();

  mockState.isWhisperConfigured.mockReturnValue(true);
  mockState.fetchMediaBytes.mockResolvedValue({
    ok: true,
    data: { bytes: new ArrayBuffer(1024), contentType: 'audio/ogg' },
  });
  mockState.postAudioToWhisper.mockResolvedValue({
    ok: true,
    text: 'Acabo de terminar en casa de García, calle Mayor 14, cambio de termo eléctrico, 340 euros, hay que volver en un año.',
  });
  mockState.extractJobFromTranscript.mockResolvedValue({ ok: true, ...GARCIA });

  state.draftCreate.mockResolvedValue({ id: 'draft_1' });
  state.draftUpdate.mockResolvedValue({});
  state.jobCreate.mockResolvedValue({ id: 'job_1' });
  state.quoteCreate.mockResolvedValue({ id: 'sq_1' });
});

describe('captureVoiceNote', () => {
  it('crea un BORRADOR, no un trabajo: nada se guarda sin que una persona lo confirme', async () => {
    const result = await captureVoiceNote(prisma, CAPTURE_INPUT);

    expect(result.status).toBe('drafted');
    expect(state.draftCreate).toHaveBeenCalled();
    // Lo que de verdad importa de este test:
    expect(state.jobCreate).not.toHaveBeenCalled();
    expect(state.quoteCreate).not.toHaveBeenCalled();
  });

  it('guarda la transcripción LITERAL además de lo extraído', async () => {
    await captureVoiceNote(prisma, CAPTURE_INPUT);
    const data = state.draftCreate.mock.calls[0][0].data;
    // La extracción es lo que se convertirá en Job; la transcripción es la
    // prueba de qué se dijo cuando alguien diga "yo nunca dije 340 euros".
    expect(data.transcript).toContain('340 euros');
    expect(data.extracted).toMatchObject({ amount: 340, contactName: 'García' });
    expect(data.status).toBe('pending');
  });

  it('pone fecha de caducidad al borrador', async () => {
    await captureVoiceNote(prisma, CAPTURE_INPUT);
    const expiresAt = state.draftCreate.mock.calls[0][0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBe(NOW.getTime() + DRAFT_TTL_MINUTES * 60 * 1000);
  });

  it('manda el audio a Whisper con el tipo que declaró Meta, no como mp3', async () => {
    await captureVoiceNote(prisma, CAPTURE_INPUT);
    // Las notas de voz de WhatsApp son ogg/opus. Mandarlas como audio/mpeg
    // hace que algunos servidores elijan el decodificador equivocado.
    expect(mockState.postAudioToWhisper.mock.calls[0][1]).toMatchObject({
      contentType: 'audio/ogg',
      filename: 'nota.ogg',
    });
  });

  it('NO crea borrador cuando no se entiende si era un trabajo o un presupuesto', async () => {
    mockState.extractJobFromTranscript.mockResolvedValue({
      ok: true,
      ...GARCIA,
      kind: 'unclear',
    });
    const result = await captureVoiceNote(prisma, CAPTURE_INPUT);

    expect(result.status).toBe('unclear');
    // Un borrador 'unclear' pendiente solo serviría para que el siguiente
    // "sí" confirmara algo que no era ni una cosa ni la otra.
    expect(state.draftCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['sin Whisper configurado', () => mockState.isWhisperConfigured.mockReturnValue(false), 'not_configured'],
    ['si no se puede bajar el audio', () => mockState.fetchMediaBytes.mockResolvedValue({ ok: false, error: 'whatsapp_media_fetch_404' }), 'media'],
    ['si la transcripción falla', () => mockState.postAudioToWhisper.mockResolvedValue({ ok: false, error: 'whisper_500', retryable: true }), 'transcription'],
    ['si la extracción falla', () => mockState.extractJobFromTranscript.mockResolvedValue({ ok: false, error: 'anthropic_api_invalid_json' }), 'extraction'],
  ])('falla con gracia %s', async (_label, arrange, reason) => {
    arrange();
    const result = await captureVoiceNote(prisma, CAPTURE_INPUT);
    expect(result).toMatchObject({ status: 'failed', reason });
    expect(state.draftCreate).not.toHaveBeenCalled();
  });

  it('degrada sin clave de Anthropic en vez de fingir que entendió algo', async () => {
    mockState.extractJobFromTranscript.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const result = await captureVoiceNote(prisma, CAPTURE_INPUT);
    expect(result).toMatchObject({ status: 'failed', reason: 'not_configured' });
  });
});

describe('confirmationCard', () => {
  it('enseña lo que se entendió', () => {
    const card = confirmationCard(GARCIA);
    expect(card).toContain('García');
    expect(card).toContain('340');
    expect(card).toContain('12 meses');
    expect(card).toMatch(/SÍ/);
  });

  // Un resumen que esconde los huecos hace que se confirmen trabajos sin
  // importe sin que nadie se dé cuenta.
  it('ENSEÑA LO QUE FALTA, no solo lo que hay', () => {
    const card = confirmationCard({ ...GARCIA, amount: null, contactName: null });
    expect(card).toContain('sin importe');
    expect(card).toContain('—');
  });

  it('distingue un presupuesto de un trabajo terminado', () => {
    expect(confirmationCard({ ...GARCIA, kind: 'quote' })).toMatch(/^Presupuesto:/);
    expect(confirmationCard(GARCIA)).toMatch(/^Trabajo terminado:/);
  });
});

describe('confirmationIntent', () => {
  it.each(['sí', 'SI', 'si', 'vale', 'ok', 'correcto', 'confirmo', 'sí, guárdalo'])(
    'lee "%s" como confirmación',
    (text) => expect(confirmationIntent(text)).toBe('yes'),
  );

  it.each(['no', 'NO', 'descartar', 'está mal', 'no, bórralo'])(
    'lee "%s" como rechazo',
    (text) => expect(confirmationIntent(text)).toBe('no'),
  );

  // Aquí "no" SÍ cuenta, al revés que en el detector de bajas. No es
  // incoherencia: allí era ambiguo y la consecuencia irreversible; aquí
  // hay una pregunta de sí o no delante y se puede volver a dictar.
  it('un "no" a secas cuenta aquí, porque hay una pregunta de sí o no delante', () => {
    expect(confirmationIntent('no')).toBe('no');
  });

  it('no confunde una frase larga con una confirmación', () => {
    expect(confirmationIntent('no, mejor apúntalo como 400 que me equivoqué al decirlo')).toBe('other');
    expect(confirmationIntent('sí pero antes quería comentarte otra cosa del presupuesto')).toBe('other');
  });

  it('cualquier otra cosa es "other", para que siga su camino', () => {
    expect(confirmationIntent('1 y 3')).toBe('other');
    expect(confirmationIntent('')).toBe('other');
  });
});

describe('resolveDraftWithReply', () => {
  const DRAFT = {
    id: 'draft_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    contactId: null,
    kind: 'job',
    transcript: 'Acabo de terminar en casa de García… 340 euros…',
    extracted: GARCIA,
    createdAt: new Date('2026-09-15T11:50:00Z'),
    expiresAt: new Date('2026-09-15T12:50:00Z'),
  };

  beforeEach(() => state.draftFindFirst.mockResolvedValue(DRAFT));

  it('convierte el borrador en Job cuando dice que sí', async () => {
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });

    expect(result).toMatchObject({ status: 'created', kind: 'job', id: 'job_1' });
    expect(state.jobCreate.mock.calls[0][0].data).toMatchObject({
      clientId: 'client_1',
      serviceType: 'cambio de termo eléctrico',
      amount: 340,
      captureMethod: 'voice_note',
      // La prueba de qué se dijo viaja al Job.
      rawCapture: expect.stringContaining('340 euros'),
    });
  });

  it('calcula la fecha de revisión EN EL PORTAL a partir de completedAt', async () => {
    await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });
    const due = state.jobCreate.mock.calls[0][0].data.nextServiceDueAt as Date;
    // 12 meses desde el 15 de septiembre de 2026. El modelo dijo "un año";
    // la aritmética es nuestra, y el modelo ni siquiera sabe qué día es hoy.
    expect(due.toISOString().slice(0, 7)).toBe('2027-09');
  });

  it('crea un ServiceQuote cuando el borrador era un presupuesto', async () => {
    state.draftFindFirst.mockResolvedValue({ ...DRAFT, kind: 'quote' });
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });

    expect(result).toMatchObject({ status: 'created', kind: 'quote' });
    expect(state.quoteCreate.mock.calls[0][0].data).toMatchObject({ status: 'open', amount: 340 });
    expect(state.jobCreate).not.toHaveBeenCalled();
  });

  it('descarta sin crear nada cuando dice que no', async () => {
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'no', now: NOW });
    expect(result.status).toBe('discarded');
    expect(state.jobCreate).not.toHaveBeenCalled();
    expect(state.draftUpdate.mock.calls[0][0].data).toMatchObject({ status: 'discarded' });
  });

  // El test que impide el trabajo inventado con el importe de otro.
  it('un "sí" TARDÍO no confirma nada: se marca caducado y se pide que lo repita', async () => {
    state.draftFindFirst.mockResolvedValue({
      ...DRAFT,
      expiresAt: new Date('2026-09-15T11:00:00Z'), // ya pasó
    });
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });

    expect(result.status).toBe('expired');
    expect(state.jobCreate).not.toHaveBeenCalled();
    expect(state.draftUpdate.mock.calls[0][0].data).toMatchObject({ status: 'expired' });
  });

  it('devuelve no_draft sin tocar la base cuando la respuesta no es sí ni no', async () => {
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: '1 y 3', now: NOW });
    expect(result).toEqual({ status: 'no_draft' });
    // Importante: ni siquiera consulta. Así no puede tragarse una
    // respuesta al resumen diario, que es lo que viene detrás en la ruta.
    expect(state.draftFindFirst).not.toHaveBeenCalled();
  });

  it('devuelve no_draft cuando no hay ningún borrador pendiente', async () => {
    state.draftFindFirst.mockResolvedValue(null);
    const result = await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });
    expect(result).toEqual({ status: 'no_draft' });
  });

  it('coge el borrador MÁS RECIENTE de esa suscripción', async () => {
    await resolveDraftWithReply(prisma, { subscriptionId: 'sub_1', text: 'sí', now: NOW });
    expect(state.draftFindFirst.mock.calls[0][0]).toMatchObject({
      where: { subscriptionId: 'sub_1', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
  });
});
