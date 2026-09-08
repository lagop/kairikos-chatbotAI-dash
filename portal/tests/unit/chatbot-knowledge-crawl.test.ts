// =============================================================================
// Fase 3 — unit tests para src/lib/chatbot-knowledge-crawl.ts.
//
// Dos cosas se prueban a fondo porque las dos fallan en silencio:
//
//   • isCrawlableUrl. Es lo único que impide que un cliente nos haga
//     descargar http://localhost:5432 y usar nuestro servidor como sonda
//     de su red. Un agujero aquí no da error: da una respuesta.
//   • htmlToParagraphs. Si se pierden los saltos de párrafo, chunkText
//     recibe un solo bloque gigante y el troceado deja de existir sin que
//     nada avise.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ logError: vi.fn(), ingest: vi.fn() }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/chatbot-knowledge', () => ({
  ingestKnowledgeDocument: (...a: unknown[]) => mockState.ingest(...a),
}));

import {
  isCrawlableUrl,
  htmlToParagraphs,
  extractTitle,
  fetchPageAsText,
  sweepPendingKnowledgeCrawls,
  CRAWL_BATCH_SIZE,
} from '@/lib/chatbot-knowledge-crawl';

describe('isCrawlableUrl', () => {
  it('acepta una web pública', () => {
    expect(isCrawlableUrl('https://peluqueriaaurora.es/servicios')).toBe(true);
    expect(isCrawlableUrl('http://ejemplo.com')).toBe(true);
  });

  it('rechaza lo que no es http(s)', () => {
    expect(isCrawlableUrl('file:///etc/passwd')).toBe(false);
    expect(isCrawlableUrl('ftp://ejemplo.com')).toBe(false);
    expect(isCrawlableUrl('no es una url')).toBe(false);
  });

  it('rechaza localhost y el bucle local', () => {
    expect(isCrawlableUrl('http://localhost:3000')).toBe(false);
    expect(isCrawlableUrl('http://127.0.0.1:5432')).toBe(false);
    expect(isCrawlableUrl('http://[::1]/')).toBe(false);
  });

  it('rechaza el direccionamiento privado', () => {
    expect(isCrawlableUrl('http://10.0.0.5/')).toBe(false);
    expect(isCrawlableUrl('http://192.168.1.1/')).toBe(false);
    expect(isCrawlableUrl('http://172.16.0.1/')).toBe(false);
    expect(isCrawlableUrl('http://172.31.255.1/')).toBe(false);
  });

  it('deja pasar el rango 172 que sí es público', () => {
    expect(isCrawlableUrl('http://172.32.0.1/')).toBe(true);
    expect(isCrawlableUrl('http://172.15.0.1/')).toBe(true);
  });

  it('rechaza los metadatos de la nube y los nombres de servicio internos', () => {
    expect(isCrawlableUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isCrawlableUrl('http://db:5432/')).toBe(false);
    expect(isCrawlableUrl('http://app.internal/')).toBe(false);
  });
});

describe('htmlToParagraphs', () => {
  it('conserva la separación entre párrafos, que es por donde se trocea', () => {
    const text = htmlToParagraphs('<p>Primero.</p><p>Segundo.</p>');
    expect(text).toBe('Primero.\n\nSegundo.');
  });

  it('tira scripts, estilos y comentarios', () => {
    const text = htmlToParagraphs('<p>Hola</p><script>alert(1)</script><style>p{}</style><!-- oculto -->');
    expect(text).toBe('Hola');
  });

  it('tira la navegación y el pie, que se repiten en todas las páginas', () => {
    const text = htmlToParagraphs('<nav><a>Inicio</a><a>Contacto</a></nav><p>Lo que importa.</p><footer>© 2026</footer>');
    expect(text).toBe('Lo que importa.');
  });

  it('convierte los saltos de línea explícitos', () => {
    expect(htmlToParagraphs('<p>Lunes<br>Martes</p>')).toBe('Lunes\nMartes');
  });

  it('decodifica las entidades, incluidas las numéricas', () => {
    expect(htmlToParagraphs('<p>Ma&ntilde;ana &amp; tarde</p>')).toContain('&');
    expect(htmlToParagraphs('<p>caf&#233;</p>')).toBe('café');
  });

  it('los encabezados también abren párrafo', () => {
    expect(htmlToParagraphs('<h2>Servicios</h2><p>Corte y color.</p>')).toBe('Servicios\n\nCorte y color.');
  });
});

describe('extractTitle', () => {
  it('saca el título de la página', () => {
    expect(extractTitle('<html><head><title> Servicios · Aurora </title></head>')).toBe('Servicios · Aurora');
  });

  it('sin título devuelve null en vez de inventarse uno', () => {
    expect(extractTitle('<html><body>hola</body></html>')).toBeNull();
    expect(extractTitle('<title>   </title>')).toBeNull();
  });
});

describe('fetchPageAsText', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('rechaza una URL no permitida sin llegar a pedirla', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchPageAsText('http://localhost/x')).toEqual({ ok: false, error: 'url_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('devuelve el texto y el título de una página normal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html><head><title>Servicios</title></head><body><p>Corte 20€.</p><p>Color 45€.</p></body></html>',
      }),
    );
    expect(await fetchPageAsText('https://aurora.example/servicios')).toEqual({
      ok: true,
      data: { title: 'Servicios', text: 'Corte 20€.\n\nColor 45€.' },
    });
  });

  it('una web que se pinta con JavaScript se reporta como tal, no como documento vacío', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><body><div id="root"></div><script>render()</script></body></html>',
      }),
    );
    expect(await fetchPageAsText('https://aurora.example/')).toEqual({ ok: false, error: 'no_readable_text' });
  });

  it('un error HTTP se devuelve con su código, para poder explicárselo al cliente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() }));
    expect(await fetchPageAsText('https://aurora.example/no-existe')).toEqual({ ok: false, error: 'http_404' });
  });

  it('un PDF no es una página', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'application/pdf' }), text: async () => '' }),
    );
    const result = await fetchPageAsText('https://aurora.example/tarifas.pdf');
    expect(result).toEqual({ ok: false, error: 'unsupported_content_type:application/pdf' });
  });
});

describe('sweepPendingKnowledgeCrawls', () => {
  const state = {
    findMany: vi.fn(),
    update: vi.fn(),
    auditCreate: vi.fn(),
  };
  const tx = {
    chatbotKnowledgeDocument: { update: (...a: unknown[]) => state.update(...a) },
    chatbotKnowledgeDocumentAudit: { create: (...a: unknown[]) => state.auditCreate(...a) },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    chatbotKnowledgeDocument: { findMany: (...a: unknown[]) => state.findMany(...a) },
  } as unknown as PrismaClient;

  const NOW = new Date('2026-09-20T10:00:00Z');
  const doc = { id: 'doc_1', clientId: 'c1', tenantId: 't1', title: 'https://aurora.example/a', sourceUrl: 'https://aurora.example/a' };

  beforeEach(() => {
    for (const fn of Object.values(state)) fn.mockReset();
    mockState.ingest.mockReset().mockResolvedValue({ ok: true, documentId: 'doc_1', chunks: 3, charCount: 900 });
    state.findMany.mockResolvedValue([]);
    state.update.mockResolvedValue({});
    state.auditCreate.mockResolvedValue({});
    vi.unstubAllGlobals();
  });

  it('con la cola vacía no hace nada más que mirar', async () => {
    expect(await sweepPendingKnowledgeCrawls(prisma, NOW)).toEqual({ processed: 0, ingested: 0, failed: 0 });
    expect(mockState.ingest).not.toHaveBeenCalled();
  });

  it('solo mira los pendientes de web, y de pocos en pocos', async () => {
    await sweepPendingKnowledgeCrawls(prisma, NOW);
    expect(state.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'pending', source: 'web', sourceUrl: { not: null } },
        take: CRAWL_BATCH_SIZE,
      }),
    );
  });

  it('indexa la página con el título real, no con la URL provisional', async () => {
    state.findMany.mockResolvedValue([doc]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<title>Nuestros servicios</title><p>Corte y color.</p>',
      }),
    );

    expect(await sweepPendingKnowledgeCrawls(prisma, NOW)).toEqual({ processed: 1, ingested: 1, failed: 0 });
    expect(mockState.ingest).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        documentId: 'doc_1',
        title: 'Nuestros servicios',
        source: 'web',
        actorId: 'system:knowledge',
      }),
    );
  });

  it('un fallo deja el documento marcado con su motivo y no se reintenta solo', async () => {
    state.findMany.mockResolvedValue([doc]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Headers() }));

    expect(await sweepPendingKnowledgeCrawls(prisma, NOW)).toEqual({ processed: 1, ingested: 0, failed: 1 });
    // 'failed', no 'pending': el barrido siguiente ya no lo verá.
    expect(state.update).toHaveBeenCalledWith({
      where: { id: 'doc_1' },
      data: { status: 'failed', error: 'http_403', crawledAt: NOW },
    });
    expect(state.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'crawl_failed' }) }),
    );
  });

  it('una página que descarga bien pero no deja nada que indexar también se marca', async () => {
    state.findMany.mockResolvedValue([doc]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<p>ok</p>',
      }),
    );
    mockState.ingest.mockResolvedValue({ ok: false, error: 'empty_content' });

    expect(await sweepPendingKnowledgeCrawls(prisma, NOW)).toEqual({ processed: 1, ingested: 0, failed: 1 });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', error: 'empty_content' }) }),
    );
  });
});

// Regresión encontrada por el test de fetchPageAsText: el <title> es texto
// de verdad y se colaba al principio del primer párrafo, dejando el título
// del documento duplicado dentro de su propio contenido.
describe('htmlToParagraphs — el <head> no es contenido', () => {
  it('no arrastra el <title> al cuerpo', () => {
    expect(htmlToParagraphs('<html><head><title>Servicios</title></head><body><p>Corte 20€.</p></body></html>')).toBe(
      'Corte 20€.',
    );
  });

  it('también con un <title> suelto, sin <head> cerrado', () => {
    expect(htmlToParagraphs('<title>Servicios</title><p>Corte 20€.</p>')).toBe('Corte 20€.');
  });
});
