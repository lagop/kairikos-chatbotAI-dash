// =============================================================================
// Fase 3 — unit tests para src/lib/chatbot-knowledge.ts.
//
// El troceado es lo que hay que fijar aquí: de él depende que un fragmento
// recuperado signifique algo por sí solo. Un corte a mitad de frase produce
// material del negocio truncado, que el modelo leería igualmente como un
// hecho.
//
// De la recuperación se prueba lo que se puede probar sin Postgres: que no
// consulta con la cadena vacía y que un fallo devuelve [] en vez de tumbar
// la conversación. El SQL de verdad se comprobó contra el Postgres real
// (los tests unitarios mockean Prisma).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  chunkText,
  retrieveKnowledge,
  ingestKnowledgeDocument,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  MAX_DOCUMENTS_PER_CHATBOT,
  MAX_DOCUMENT_CHARS,
} from '@/lib/chatbot-knowledge';

describe('chunkText', () => {
  it('un texto vacío no produce fragmentos', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('un texto corto es un solo fragmento', () => {
    expect(chunkText('Abrimos de 9 a 14 y de 16 a 20.')).toEqual(['Abrimos de 9 a 14 y de 16 a 20.']);
  });

  it('junta párrafos cortos hasta el tamaño objetivo, sin partirlos', () => {
    const a = 'a'.repeat(300);
    const b = 'b'.repeat(300);
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(`${a}\n\n${b}`);
  });

  it('abre fragmento nuevo cuando el siguiente párrafo ya no cabe', () => {
    const a = 'a'.repeat(600);
    const b = 'b'.repeat(600);
    const chunks = chunkText(`${a}\n\n${b}`);
    expect(chunks).toEqual([a, b]);
  });

  it('normaliza los saltos de un copiar-pegar sin perder la separación de párrafos', () => {
    const chunks = chunkText('Primero.\r\n\r\n\r\n\r\nSegundo.');
    expect(chunks).toEqual(['Primero.\n\nSegundo.']);
  });

  it('parte por frases un párrafo que por sí solo no cabe', () => {
    const sentence = `${'x'.repeat(200)}. `;
    const chunks = chunkText(sentence.repeat(12));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // El corte cae en un final de frase, no a media palabra.
    expect(chunks[0].endsWith('.')).toBe(true);
  });

  it('corta en seco un bloque sin puntuación, antes que devolver algo que no cabe', () => {
    const chunks = chunkText('z'.repeat(CHUNK_MAX_CHARS * 3));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it('no pierde texto por el camino', () => {
    const source = Array.from({ length: 20 }, (_, i) => `Párrafo ${i} con algo de contenido real.`).join('\n\n');
    const joined = chunkText(source).join('\n\n');
    expect(joined).toBe(source);
  });

  it('los topes son decisiones de producto, no números sueltos', () => {
    expect(CHUNK_TARGET_CHARS).toBe(800);
    expect(MAX_DOCUMENTS_PER_CHATBOT).toBe(25);
  });
});

describe('retrieveKnowledge', () => {
  const queryRaw = vi.fn();
  const prisma = { $queryRaw: (...a: unknown[]) => queryRaw(...a) } as unknown as PrismaClient;

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([]);
    mockState.logError.mockReset();
  });

  it('no consulta con un mensaje vacío', async () => {
    expect(await retrieveKnowledge(prisma, 'c1', '   ')).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('devuelve el fragmento con el título de su documento', async () => {
    queryRaw.mockResolvedValue([{ content: 'Admitimos mascotas.', title: 'Normas del local' }]);
    expect(await retrieveKnowledge(prisma, 'c1', '¿puedo llevar al perro?')).toEqual([
      { documentTitle: 'Normas del local', content: 'Admitimos mascotas.' },
    ]);
  });

  it('nunca lanza: sin base de conocimiento el bot tiene que seguir contestando', async () => {
    queryRaw.mockRejectedValue(new Error('relation does not exist'));
    expect(await retrieveKnowledge(prisma, 'c1', 'hola')).toEqual([]);
    expect(mockState.logError).toHaveBeenCalledWith(
      'chatbot_knowledge.retrieve_failed',
      expect.any(Error),
      { clientId: 'c1' },
      'warn',
    );
  });
});

describe('ingestKnowledgeDocument', () => {
  const state = {
    documentCount: vi.fn(),
    documentCreate: vi.fn(),
    documentUpdate: vi.fn(),
    chunkDeleteMany: vi.fn(),
    chunkCreateMany: vi.fn(),
    auditCreate: vi.fn(),
  };

  const tx = {
    chatbotKnowledgeDocument: {
      create: (...a: unknown[]) => state.documentCreate(...a),
      update: (...a: unknown[]) => state.documentUpdate(...a),
    },
    chatbotKnowledgeChunk: {
      deleteMany: (...a: unknown[]) => state.chunkDeleteMany(...a),
      createMany: (...a: unknown[]) => state.chunkCreateMany(...a),
    },
    chatbotKnowledgeDocumentAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
  };

  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    chatbotKnowledgeDocument: { count: (...a: unknown[]) => state.documentCount(...a) },
  } as unknown as PrismaClient;

  const base = {
    clientId: 'c1',
    tenantId: 't1',
    source: 'manual' as const,
    title: 'Política de cancelaciones',
    content: 'Se puede cancelar hasta 24 horas antes sin coste.',
    actorId: 'client:c1',
    now: new Date('2026-09-20T10:00:00Z'),
  };

  beforeEach(() => {
    for (const fn of Object.values(state)) fn.mockReset();
    state.documentCount.mockResolvedValue(0);
    state.documentCreate.mockResolvedValue({ id: 'doc_1' });
    state.documentUpdate.mockResolvedValue({ id: 'doc_1' });
    state.chunkCreateMany.mockResolvedValue({ count: 1 });
    state.chunkDeleteMany.mockResolvedValue({ count: 0 });
    state.auditCreate.mockResolvedValue({});
  });

  it('rechaza un documento sin nada que indexar antes de tocar la base de datos', async () => {
    const result = await ingestKnowledgeDocument(prisma, { ...base, content: '   ' });
    expect(result).toEqual({ ok: false, error: 'empty_content' });
    expect(state.documentCreate).not.toHaveBeenCalled();
  });

  it('respeta el tope de documentos por cliente', async () => {
    state.documentCount.mockResolvedValue(MAX_DOCUMENTS_PER_CHATBOT);
    expect(await ingestKnowledgeDocument(prisma, base)).toEqual({
      ok: false,
      error: 'document_limit_reached',
    });
    expect(state.documentCreate).not.toHaveBeenCalled();
  });

  it('guarda el documento con sus fragmentos numerados y su auditoría', async () => {
    const result = await ingestKnowledgeDocument(prisma, base);

    expect(result).toMatchObject({ ok: true, documentId: 'doc_1', chunks: 1 });
    expect(state.chunkCreateMany).toHaveBeenCalledWith({
      data: [{ documentId: 'doc_1', clientId: 'c1', ordinal: 0, content: base.content }],
    });
    expect(state.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'created', actorId: 'client:c1' }),
      }),
    );
  });

  it('la auditoría guarda metadatos, nunca el contenido del documento', async () => {
    await ingestKnowledgeDocument(prisma, base);
    const after = state.auditCreate.mock.calls[0][0].data.after;
    expect(after).toEqual({ source: 'manual', title: base.title, chunks: 1, charCount: base.content.length });
    expect(JSON.stringify(after)).not.toContain('24 horas');
  });

  it('un recrawl reemplaza los fragmentos en vez de acumularlos', async () => {
    await ingestKnowledgeDocument(prisma, { ...base, source: 'web', documentId: 'doc_1' });
    expect(state.chunkDeleteMany).toHaveBeenCalledWith({ where: { documentId: 'doc_1' } });
    expect(state.documentCreate).not.toHaveBeenCalled();
    expect(state.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'recrawled' }) }),
    );
    // Y no vuelve a comprobar el tope: no está creando nada nuevo.
    expect(state.documentCount).not.toHaveBeenCalled();
  });

  it('recorta un documento desmesurado en vez de rechazarlo', async () => {
    await ingestKnowledgeDocument(prisma, { ...base, content: 'a '.repeat(MAX_DOCUMENT_CHARS) });
    const charCount = state.documentCreate.mock.calls[0][0].data.charCount;
    expect(charCount).toBe(MAX_DOCUMENT_CHARS);
  });

  it('solo un documento de web se marca como rastreado', async () => {
    await ingestKnowledgeDocument(prisma, base);
    expect(state.documentCreate.mock.calls[0][0].data.crawledAt).toBeNull();

    state.documentCreate.mockClear();
    await ingestKnowledgeDocument(prisma, { ...base, source: 'web', sourceUrl: 'https://x.example/a' });
    expect(state.documentCreate.mock.calls[0][0].data.crawledAt).toEqual(base.now);
  });
});

// Regresión encontrada contra el Postgres real: websearch_to_tsquery une
// los términos con AND, así que "¿cómo hago una cancelación?" exigía que
// 'com', 'hag' y 'cancel' estuvieran en el MISMO fragmento y no encontraba
// nada. Que la consulta salga en OR no es una preferencia de estilo: es lo
// único que hace que la base de conocimiento devuelva algo.
describe('retrieveKnowledge — la consulta va en OR', () => {
  const queryRaw = vi.fn();
  const prisma = { $queryRaw: (...a: unknown[]) => queryRaw(...a) } as unknown as PrismaClient;

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([]);
  });

  it('reescribe el AND de websearch_to_tsquery a OR', async () => {
    await retrieveKnowledge(prisma, 'c1', 'cancelar cita');
    const sql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toContain("replace(websearch_to_tsquery('spanish', ?)::text, '&', '|')");
  });

  it('quita la negación, que en OR casaría con casi todo', async () => {
    await retrieveKnowledge(prisma, 'c1', '-color mechas');
    const sql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toContain("'!', ''");
  });

  it('el mensaje del cliente viaja como parámetro, nunca interpolado', async () => {
    await retrieveKnowledge(prisma, 'c1', "'; DROP TABLE x; --");
    const call = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(call.values).toContain("'; DROP TABLE x; --");
    expect(call.strings.join('')).not.toContain('DROP TABLE');
  });
});
