import { describe, it, expect } from 'vitest';
import { perfilIdiomasFromStep1, step2Schema } from '@/lib/wizard-schemas';

// Paso 2 del asistente: el trato (tú/usted) puede cambiar por idioma con
// `tratamiento_por_idioma` (18/11/2026). Opcional: lo ya guardado, sin el
// campo, tiene que seguir pasando igual.
const base = {
  tono: 'cercano',
  tratamiento: 'tu',
  temas_prohibidos: { checklist: ['otro'] },
};

describe('step2Schema · tratamiento_por_idioma', () => {
  it('lo guardado sin el campo sigue siendo válido', () => {
    const r = step2Schema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tratamiento_por_idioma).toBeUndefined();
  });

  it('admite un trato distinto en alemán y lo conserva', () => {
    const r = step2Schema.safeParse({ ...base, tratamiento_por_idioma: { DE: 'usted' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tratamiento_por_idioma).toEqual({ DE: 'usted' });
  });

  it('descarta los idiomas vacíos («igual que el general»)', () => {
    const r = step2Schema.safeParse({ ...base, tratamiento_por_idioma: { EN: '', DE: 'usted' } });
    expect(r.success).toBe(true);
    if (r.success) expect(JSON.parse(JSON.stringify(r.data.tratamiento_por_idioma))).toEqual({ DE: 'usted' });
  });

  it('sin ningún idioma con valor, el campo desaparece', () => {
    const r = step2Schema.safeParse({ ...base, tratamiento_por_idioma: { EN: '', DE: null } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tratamiento_por_idioma).toBeUndefined();
  });

  it('rechaza un trato que no sea tú o usted', () => {
    const r = step2Schema.safeParse({ ...base, tratamiento_por_idioma: { DE: 'vos' } });
    expect(r.success).toBe(false);
  });

  it('ignora idiomas que el asistente no tiene', () => {
    const r = step2Schema.safeParse({ ...base, tratamiento_por_idioma: { FR: 'usted', DE: 'usted' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tratamiento_por_idioma).toEqual({ DE: 'usted' });
  });
});

describe('perfilIdiomasFromStep1', () => {
  it('lee los idiomas marcados y el principal', () => {
    expect(perfilIdiomasFromStep1({ idiomas: ['ES', 'DE', 'EN'], idioma_por_defecto: 'ES' })).toEqual({
      idiomas: ['ES', 'EN', 'DE'],
      idiomaPorDefecto: 'ES',
    });
  });

  it('null sin paso 1 o sin idiomas válidos', () => {
    expect(perfilIdiomasFromStep1(null)).toBeNull();
    expect(perfilIdiomasFromStep1({ idiomas: 'ES' })).toBeNull();
    expect(perfilIdiomasFromStep1({ idiomas: ['FR'] })).toBeNull();
  });
});
