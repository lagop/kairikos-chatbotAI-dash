// Plan de precios del 01/10/2026 — la limpieza del texto de la publicación
// semanal de la Ficha de Google gestionada (lib/gbp-post-ai.ts). Pura: sin red.

import { describe, it, expect } from 'vitest';
import { cleanGbpPost } from '@/lib/gbp-post-ai';

describe('cleanGbpPost', () => {
  it('quita comillas y vallas de markdown, y descarta lo que no es una publicación', () => {
    expect(cleanGbpPost('```\n"Revisa tu caldera antes de que llegue el frío: te ahorrarás sustos."\n```')).toBe(
      'Revisa tu caldera antes de que llegue el frío: te ahorrarás sustos.',
    );
    expect(cleanGbpPost('Vale.')).toBeNull();
  });
});
