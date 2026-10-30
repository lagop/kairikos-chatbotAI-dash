import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTH_PHOTO_COUNTS, TRADE_HERO_PHOTOS, TRADE_PHOTO_COUNTS, healthPhotoSet, tradeDetailPhotos, tradeHeroPhoto, tradePhotoSet, type HealthPhotoSet, type TradePhotoSet } from '@/lib/trade-photos';

const DIR = join(process.cwd(), 'public', 'web-draft', 'oficios');

describe('fotos de oficio', () => {
  it('están todas en public/ y ninguna sobra ni pesa de más', () => {
    const expected = Object.entries(TRADE_PHOTO_COUNTS).flatMap(([set, n]) => Array.from({ length: n }, (_, i) => `${set}-${i + 1}.jpg`));
    expect(readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort()).toEqual(expected.sort());
    // Se sirven en el móvil del prospecto, a veces con mala cobertura.
    for (const f of expected) expect(statSync(join(DIR, f)).size).toBeLessThan(400 * 1024);
  });

  // Nombres reales de prospectos de producción (28/10/2026).
  const cases: [string, string | null, TradePhotoSet | null][] = [
    ['Aluminios Marrero', 'manufacturer', 'aluminio'],
    ['Carpintería de Aluminio Luis Santana', 'manufacturer', 'aluminio'],
    ['Talleres Camacho Carpinteria de Aluminio', 'manufacturer', 'aluminio'],
    ['Carpintería Metálica Cristalería MEDINA', 'manufacturer', 'aluminio'],
    ['Sin Fin PVC SL', 'manufacturer', 'aluminio'],
    ['CARPINTERÍA CANARIAS - Carpintería de Madera', 'manufacturer', 'carpinteria'],
    ['Yuba Solar', 'service', 'solar'],
    ['Grupo Cymasol Renovables S.L.', 'service', 'solar'],
    ['Reformas Atlantico - Empresa de Reformas en Las Palmas', 'service', 'reformas'],
    ['ESCAYOLAS Y REFORMAS BOLAÑOS. SL', 'service', 'reformas'],
    ['Desatascos Jumbo', 'service', 'fontaneria'],
    ['Electrolabat', 'service', 'electricidad'],
    ['Taller Chapa y Pintura Hermanos', 'car_repair', 'taller'],
    // El nombre no dice nada: manda el tipo de Google.
    ['Hermanos Pérez', 'plumber', 'fontaneria'],
    ['Juan y Ana', 'locksmith', 'cerrajeria'],
    ['Construmax', 'general_contractor', 'reformas'],
    // Ni el nombre ni el tipo: la foto genérica de siempre.
    ['Oficina Endesa Octavio Guerra', 'service', null],
    ['José Diepa Perera', 'manufacturer', null],
    ['Huve', null, null],
  ];
  it.each(cases)('%s (%s) → %s', (name, type, set) => {
    expect(tradePhotoSet(name, type)).toBe(set);
  });

  it('el mismo negocio, la misma foto; otros negocios, fotos distintas', () => {
    const a = tradeHeroPhoto('trades', 'Aluminios Marrero', 'manufacturer');
    expect(a).toMatch(/^\/web-draft\/oficios\/aluminio-[123]\.jpg$/);
    expect(tradeHeroPhoto('trades', 'ALUMINIOS MARRERO ', 'manufacturer')).toBe(a);
    const many = new Set(['Aluminios Marrero', 'Aluminios Beyra', 'Aluminios Armas', 'Aluminios Schamann', 'Aluminios Breval', 'Aluminios RMG'].map((n) => tradeHeroPhoto('trades', n, null)));
    expect(many.size).toBeGreaterThan(1);
  });

  it('las pestañas usan las que no son de portada, en un orden estable por negocio', () => {
    const a = tradeDetailPhotos('aluminio', 'Aluminios Marrero');
    expect(a).toHaveLength(TRADE_PHOTO_COUNTS.aluminio - TRADE_HERO_PHOTOS);
    expect(new Set(a).size).toBe(a.length);
    for (const f of a) expect(f).toMatch(/^\/web-draft\/oficios\/aluminio-[4-8]\.jpg$/);
    expect(tradeDetailPhotos('aluminio', 'ALUMINIOS MARRERO ')).toEqual(a);
    // La portada sigue entre las 3 de siempre aunque ahora haya 8: un borrador
    // que ya se enseñó no cambia de foto.
    for (const n of ['Aluminios Marrero', 'Yuba Solar', 'Desatascos Jumbo']) expect(tradeHeroPhoto('trades', n, null)).toMatch(/-[123]\.jpg$/);
  });

  it('solo en oficios, y lo que no se reconoce cae a la del sector', () => {
    // Una peluquería que se llame «Solar» no sale con placas: sale con la suya.
    expect(tradeHeroPhoto('beauty', 'Peluquería Solar', 'hair_salon')).toMatch(/^\/web-draft\/belleza\/peluqueria-/);
    expect(tradeHeroPhoto('trades', 'Huve', null)).toBeNull();
    for (const [set, n] of Object.entries(TRADE_PHOTO_COUNTS)) {
      for (let i = 1; i <= n; i++) expect(existsSync(join(DIR, `${set}-${i}.jpg`))).toBe(true);
    }
  });
});

describe('fotos de salud', () => {
  const SALUD = join(process.cwd(), 'public', 'web-draft', 'salud');

  it('están todas en public/ y ninguna sobra ni pesa de más', () => {
    const expected = Object.entries(HEALTH_PHOTO_COUNTS).flatMap(([set, n]) => Array.from({ length: n }, (_, i) => `${set}-${i + 1}.jpg`));
    expect(readdirSync(SALUD).filter((f) => f.endsWith('.jpg')).sort()).toEqual(expected.sort());
    for (const f of expected) expect(statSync(join(SALUD, f)).size).toBeLessThan(400 * 1024);
  });

  const cases: [string, string | null, HealthPhotoSet][] = [
    ['Clínica Dental Sonrisas', 'dentist', 'dental'],
    ['Ortodoncia Pérez', null, 'dental'],
    ['Hospital Veterinario San Bernardo', 'veterinary_care', 'veterinaria'],
    ['Fisioterapia Atlántico', 'physiotherapist', 'fisioterapia'],
    ['Osteopatía y Rehabilitación Ana', 'doctor', 'fisioterapia'],
    // El nombre no dice nada: manda el tipo de Google.
    ['Centro Médico Las Palmas', 'dental_clinic', 'dental'],
    ['Ana Suárez', 'veterinary_care', 'veterinaria'],
    // Ni una cosa ni otra: la consulta genérica, no la foto del sector.
    ['Centro Médico Triana', 'doctor', 'clinica'],
    ['Huve', null, 'clinica'],
  ];
  it.each(cases)('%s (%s) → %s', (name, type, set) => {
    expect(healthPhotoSet(name, type)).toBe(set);
  });

  it('el mismo negocio, la misma foto; siempre hay una', () => {
    const a = tradeHeroPhoto('health', 'Clínica Dental Sonrisas', 'dentist');
    expect(a).toMatch(/^\/web-draft\/salud\/dental-[1-5]\.jpg$/);
    expect(tradeHeroPhoto('health', 'CLÍNICA DENTAL SONRISAS ', 'dentist')).toBe(a);
    expect(tradeHeroPhoto('health', 'Huve', null)).toMatch(/^\/web-draft\/salud\/clinica-[1-4]\.jpg$/);
    // Un oficio que se llame «Dental» no sale con sillones: no es de salud.
    expect(tradeHeroPhoto('trades', 'Dental Hermanos', null)).toBeNull();
  });
});
