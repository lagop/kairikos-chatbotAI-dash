// =============================================================================
// Reseñas en la web Premium (23/11/2026) — el feed que lee cada noche la build
// de la web del cliente (lib/review-feed-rules.ts, lib/review-feed.ts y
// GET /api/public/resenas/[token]/feed).
//
// Lo que no puede pasar:
//   - que la web publique una reseña que ya no está en Google;
//   - que publique la traducción de Google como si la hubiera escrito el autor;
//   - que el token sirva sin la contratación de Reseñas o que se guarde en claro;
//   - que una sincronización vacía marque como borradas todas las reseñas.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  connFindUnique: vi.fn(),
  connUpdate: vi.fn(),
  reviewFindMany: vi.fn(),
  cpFindFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    googleBusinessConnection: {
      findUnique: (...a: unknown[]) => state.connFindUnique(...a),
      update: (...a: unknown[]) => state.connUpdate(...a),
    },
    googleReview: { findMany: (...a: unknown[]) => state.reviewFindMany(...a) },
    clientProduct: { findFirst: (...a: unknown[]) => state.cpFindFirst(...a) },
  },
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import {
  buildReviewFeed,
  detectLang,
  generateReviewFeedToken,
  hashReviewFeedToken,
  isReviewFeedTokenShape,
  originalText,
  reviewFeedUrl,
  shortAuthor,
  webFeedState,
  FEED_STALE_AFTER_MS,
  type FeedReviewRow,
} from '@/lib/review-feed-rules';
import { GET as feedGet } from '@/app/api/public/resenas/[token]/feed/route';

// El esquema con el que la plantilla dental valida el feed (src/lib/reviews.ts
// de kairikos-signature-dental, docs/resenas.md). Si el feed deja de cumplirlo,
// la build de la web falla.
const langText = z.record(z.string(), z.string().min(1));
const templateSchema = z.object({
  syncedAt: z.coerce.date().optional(),
  writeUrl: z.string().url().optional(),
  topics: z.array(z.object({ id: z.string(), tone: z.enum(['pos', 'neg']), es: z.string(), en: z.string() })).default([]),
  reviews: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      rating: z.number().int().min(1).max(5),
      date: z.coerce.date(),
      lang: z.string(),
      text: langText.optional(),
      treatment: z.string().optional(),
      topics: z.array(z.string()).default([]),
      reply: z.object({ date: z.coerce.date(), text: langText }).optional(),
      url: z.string().url().optional(),
      featured: z.boolean().default(false),
    }),
  ),
});

const row = (over: Partial<FeedReviewRow> = {}): FeedReviewRow => ({
  googleReviewId: 'accounts/111/locations/222/reviews/AbC123',
  reviewerName: 'Marta García López',
  starRating: 5,
  comment: 'Muy buen trato, nos explicaron todo con calma.',
  createTime: new Date('2026-11-02T17:12:00Z'),
  updateTime: new Date('2026-11-02T17:12:00Z'),
  replyComment: null,
  replyUpdatedAt: null,
  removedAt: null,
  ...over,
});

const TOKEN = 'rsf_abcdefghijklmnopqrstuvwx';

beforeEach(() => {
  Object.values(state).forEach((f) => f.mockReset());
  state.connUpdate.mockResolvedValue({});
});

describe('el token', () => {
  it('tiene 144 bits, forma fija y solo se guarda su hash', () => {
    const t = generateReviewFeedToken();
    expect(isReviewFeedTokenShape(t)).toBe(true);
    expect(generateReviewFeedToken()).not.toBe(t);
    expect(hashReviewFeedToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReviewFeedToken(t)).not.toContain(t);
    for (const bad of ['', 'car_abcdefghijklmnopqrstuvwx', 'rsf_corto', `${TOKEN}x`, 'rsf_abcdefghijklmnopqrstuv x']) {
      expect(isReviewFeedTokenShape(bad)).toBe(false);
    }
  });

  it('la URL del feed es la del portal, sin barra doble', () => {
    expect(reviewFeedUrl('https://portal.kairikos.cloud/', TOKEN)).toBe(`https://portal.kairikos.cloud/api/public/resenas/${TOKEN}/feed`);
  });
});

describe('el texto y el autor', () => {
  it('publica el original, nunca la traducción de Google', () => {
    expect(originalText('(Translated by Google) Very good\n\n(Original)\nMuy bueno')).toBe('Muy bueno');
    expect(originalText('Sehr gut\n\n(Translated by Google)\nMuy bueno')).toBe('Sehr gut');
    expect(originalText('  Normal  ')).toBe('Normal');
    expect(originalText('')).toBeNull();
    expect(originalText(null)).toBeNull();
  });

  it('detecta español, inglés y alemán; si duda, el idioma de la web', () => {
    expect(detectLang('Muy buen trato, nos explicaron todo con calma y sin prisas')).toBe('es');
    expect(detectLang('The staff were really friendly and we would come back')).toBe('en');
    expect(detectLang('Wir waren sehr zufrieden, das Team ist immer freundlich')).toBe('de');
    expect(detectLang('Ok 👍')).toBe('es');
    expect(detectLang('Top', 'en')).toBe('en');
  });

  it('nombre de pila e inicial; sin nombre, Anónimo', () => {
    expect(shortAuthor('Marta García López')).toBe('Marta G.');
    expect(shortAuthor('Thomas  klein')).toBe('Thomas K.');
    expect(shortAuthor('Iván')).toBe('Iván');
    expect(shortAuthor('Álvaro Íñiguez')).toBe('Álvaro Í.');
    expect(shortAuthor(null)).toBe('Anónimo');
    expect(shortAuthor('A Google User')).toBe('Anónimo');
  });
});

describe('el feed', () => {
  it('cumple el esquema de la plantilla y no publica las borradas ni las sin estrellas', () => {
    const feed = buildReviewFeed(
      [
        row(),
        row({ googleReviewId: 'accounts/1/locations/2/reviews/old', createTime: new Date('2026-01-01T00:00:00Z'), comment: null, reviewerName: 'Iván G.', starRating: 2 }),
        row({ googleReviewId: 'accounts/1/locations/2/reviews/gone', removedAt: new Date() }),
        row({ googleReviewId: 'accounts/1/locations/2/reviews/zero', starRating: 0 }),
        row({
          googleReviewId: 'accounts/1/locations/2/reviews/en',
          createTime: new Date('2026-11-10T10:00:00Z'),
          comment: 'The staff were really friendly and very clear',
          replyComment: 'Thank you for coming!',
          replyUpdatedAt: new Date('2026-11-11T09:00:00Z'),
        }),
      ],
      { syncedAt: new Date('2026-11-23T05:00:00Z'), writeUrl: 'https://g.page/r/XXXX/review' },
    );
    expect(templateSchema.safeParse(feed).success).toBe(true);
    expect(feed.reviews.map((r) => r.id)).toEqual(['en', 'AbC123', 'old']);
    expect(feed.reviews[0]).toMatchObject({
      lang: 'en',
      text: { en: 'The staff were really friendly and very clear' },
      reply: { date: '2026-11-11T09:00:00.000Z', text: { en: 'Thank you for coming!' } },
      featured: false,
    });
    // Solo estrellas: cuenta en la media de la web, no sale como tarjeta.
    expect(feed.reviews[2].text).toBeUndefined();
    expect(feed.reviews[2].rating).toBe(2);
    expect(feed.writeUrl).toBe('https://g.page/r/XXXX/review');
    expect(JSON.stringify(feed)).not.toContain('accounts/');
  });

  it('un enlace para escribir reseña que no es https no sale', () => {
    expect(buildReviewFeed([row()], { syncedAt: null, writeUrl: 'javascript:alert(1)' }).writeUrl).toBeUndefined();
    expect(buildReviewFeed([row()], { syncedAt: null, writeUrl: 'no es una url' }).writeUrl).toBeUndefined();
  });
});

describe('la salud de la web', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  it('al día si la leyó en las últimas 36 horas', () => {
    expect(webFeedState({ hasToken: false, readAt: null }, now)).toBe('sin_enlace');
    expect(webFeedState({ hasToken: true, readAt: null }, now)).toBe('sin_leer');
    expect(webFeedState({ hasToken: true, readAt: new Date(now.getTime() - 25 * 3600_000) }, now)).toBe('al_dia');
    expect(webFeedState({ hasToken: true, readAt: new Date(now.getTime() - FEED_STALE_AFTER_MS - 1) }, now)).toBe('atrasada');
  });
});

describe('GET /api/public/resenas/[token]/feed', () => {
  const get = (token = TOKEN) => feedGet(new NextRequest(`http://localhost/api/public/resenas/${token}/feed`), { params: Promise.resolve({ token }) });
  const conn = { id: 'c1', clientId: 'cli', status: 'active', lastSyncAt: new Date('2026-11-23T05:00:00Z'), reviewUrl: null };

  it('un token mal formado no llega a la base de datos', async () => {
    const res = await get('car_abcdefghijklmnopqrstuvwx');
    expect(res.status).toBe(404);
    expect(state.connFindUnique).not.toHaveBeenCalled();
  });

  it('busca por el hash, nunca por el token en claro', async () => {
    state.connFindUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(state.connFindUnique.mock.calls[0][0].where).toEqual({ websiteFeedTokenHash: hashReviewFeedToken(TOKEN) });
  });

  it('sin Reseñas contratado, 410: la web se publica sin reseñas', async () => {
    state.connFindUnique.mockResolvedValue(conn);
    state.cpFindFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(410);
    expect(state.cpFindFirst.mock.calls[0][0].where).toMatchObject({ clientId: 'cli', status: 'active', product: { code: 'reviews' } });
    expect(state.reviewFindMany).not.toHaveBeenCalled();
  });

  it('con la ficha desconectada, 410', async () => {
    state.connFindUnique.mockResolvedValue({ ...conn, status: 'revoked' });
    expect((await get()).status).toBe(410);
  });

  it('con todo en orden, el feed sin las borradas, sin caché, y apunta la lectura', async () => {
    state.connFindUnique.mockResolvedValue(conn);
    state.cpFindFirst.mockResolvedValue({ id: 'cp' });
    state.reviewFindMany.mockResolvedValue([row()]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = await res.json();
    expect(templateSchema.safeParse(body).success).toBe(true);
    expect(body.reviews).toHaveLength(1);
    expect(state.reviewFindMany.mock.calls[0][0].where).toEqual({ connectionId: 'c1', removedAt: null });
    expect(state.connUpdate).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { websiteFeedReadAt: expect.any(Date) } });
  });
});
