import { describe, it, expect } from 'vitest';
import { step1Schema } from '@/lib/wizard-schemas';

// Paso 1 del asistente: los idiomas en que contesta el bot. checkArray no limita los valores (solo exige uno),
// así que aquí se comprueba que el alemán pasa, no que otro idioma falle.
const base = { vertical: 'inmobiliaria', nombre_comercial: 'Agencia de prueba', idioma_por_defecto: 'ES' };

describe('step1Schema · idiomas', () => {
  it('admite el alemán junto al español y el inglés', () => {
    const r = step1Schema.safeParse({ ...base, idiomas: ['ES', 'EN', 'DE'] });
    expect(r.success).toBe(true);
  });

  it('admite el alemán como idioma principal si está marcado', () => {
    const r = step1Schema.safeParse({ ...base, idiomas: ['DE', 'ES'], idioma_por_defecto: 'DE' });
    expect(r.success).toBe(true);
  });
});
