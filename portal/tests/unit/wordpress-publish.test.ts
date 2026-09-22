// =============================================================================
// SEO con IA, Fase C — unit tests for src/lib/wordpress-publish.ts.
//
// Covers: hasWordPressCredentials' completeness gate, the Basic Auth
// header construction, the request/response field shapes (verified
// against WordPress's own REST API docs), and failure handling.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// safeFetch conecta con http/https de Node, no con fetch: aquí se enruta al
// fetch simulado de este archivo. Sus propias garantías (qué IPs, qué
// redirecciones) se prueban en safe-fetch.test.ts.
vi.mock('@/lib/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safe-fetch')>()),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));


const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  decryptWordPressAppPassword: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/seo', () => ({
  decryptWordPressAppPassword: (...args: unknown[]) => mockState.decryptWordPressAppPassword(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { publishDraftToWordPress, hasWordPressCredentials } from '@/lib/wordpress-publish';
import { BlockedUrlError } from '@/lib/safe-fetch';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const FULL_CREDENTIALS = {
  wordpressUrl: 'https://negocio.example',
  wordpressUsername: 'kairikos-publisher',
  wordpressAppPasswordCiphertext: Buffer.from('ct'),
  wordpressAppPasswordIv: Buffer.from('iv'),
  wordpressAppPasswordTag: Buffer.from('tag'),
};

const DRAFT = {
  title: 'Cómo elegir un cerrajero de confianza',
  bodyHtml: '<p>Contenido del artículo.</p>',
  metaDescription: 'Guía práctica.',
};

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.decryptWordPressAppPassword.mockReset().mockReturnValue('app password plain');
  mockState.logError.mockReset();
});

describe('hasWordPressCredentials', () => {
  it('true when every field is present', () => {
    expect(hasWordPressCredentials(FULL_CREDENTIALS)).toBe(true);
  });

  it('false when null/undefined', () => {
    expect(hasWordPressCredentials(null)).toBe(false);
    expect(hasWordPressCredentials(undefined)).toBe(false);
  });

  it('false when the app password ciphertext is missing (technical setup incomplete)', () => {
    expect(hasWordPressCredentials({ ...FULL_CREDENTIALS, wordpressAppPasswordCiphertext: null })).toBe(false);
  });

  it('false when the username is missing', () => {
    expect(hasWordPressCredentials({ ...FULL_CREDENTIALS, wordpressUsername: null })).toBe(false);
  });
});

describe('publishDraftToWordPress', () => {
  it('posts to /wp-json/wp/v2/posts with Basic Auth and the correct field names', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 42, link: 'https://negocio.example/2026/09/articulo' }));
    const result = await publishDraftToWordPress(FULL_CREDENTIALS, DRAFT);

    expect(result).toEqual({ ok: true, postId: '42', postUrl: 'https://negocio.example/2026/09/articulo' });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://negocio.example/wp-json/wp/v2/posts');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('kairikos-publisher:app password plain').toString('base64')}`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      title: DRAFT.title,
      content: DRAFT.bodyHtml,
      status: 'publish',
      excerpt: DRAFT.metaDescription,
    });
  });

  it('strips a trailing slash from wordpressUrl before building the endpoint', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 1, link: 'https://negocio.example/post' }));
    await publishDraftToWordPress({ ...FULL_CREDENTIALS, wordpressUrl: 'https://negocio.example/' }, DRAFT);
    expect(mockState.fetch.mock.calls[0][0]).toBe('https://negocio.example/wp-json/wp/v2/posts');
  });

  it('omits excerpt when metaDescription is null', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ id: 1, link: 'https://negocio.example/post' }));
    await publishDraftToWordPress(FULL_CREDENTIALS, { ...DRAFT, metaDescription: null });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('excerpt');
  });

  it('returns credential_decrypt_failed without calling fetch when decryption throws', async () => {
    mockState.decryptWordPressAppPassword.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    const result = await publishDraftToWordPress(FULL_CREDENTIALS, DRAFT);
    expect(result).toEqual({ ok: false, error: 'credential_decrypt_failed' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('maps a non-ok WordPress response to a descriptive error, never throws', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ code: 'rest_cannot_create' }, false, 401));
    const result = await publishDraftToWordPress(FULL_CREDENTIALS, DRAFT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('wordpress_error:401');
  });

  it('maps an unexpected response shape (missing id/link) to an error', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    const result = await publishDraftToWordPress(FULL_CREDENTIALS, DRAFT);
    expect(result).toEqual({ ok: false, error: 'unexpected_response_shape' });
  });

  // Seguridad (22/09/2026): wordpressUrl la escribe el cliente, y el error
  // de WordPress devuelve 300 bytes de la respuesta. Apuntarla a un servicio
  // interno servía para leerlo; ahora safeFetch lo rechaza al conectar.
  it('a wordpressUrl pointing inside the network is refused with a clear error', async () => {
    mockState.fetch.mockRejectedValueOnce(new BlockedUrlError('hostname'));
    const result = await publishDraftToWordPress({ ...FULL_CREDENTIALS, wordpressUrl: 'http://n8n:5678' }, DRAFT);
    expect(result).toEqual({ ok: false, error: 'wordpress_url_not_allowed' });
  });

  it('maps a network failure to its message, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('site unreachable'));
    const result = await publishDraftToWordPress(FULL_CREDENTIALS, DRAFT);
    expect(result).toEqual({ ok: false, error: 'site unreachable' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
