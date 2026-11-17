import { describe, expect, it } from 'vitest';
import { DEFAULT_VILLAS_TAB, VILLAS_TABS, neighbourVillasTab, parseVillasTab, villasTabHref } from '@/lib/villas/panel-tabs';

describe('pestañas del panel de villas', () => {
  it('sin parámetro, o con uno que no existe, cae en Reservas', () => {
    expect(parseVillasTab(undefined)).toBe('reservas');
    expect(parseVillasTab(null)).toBe('reservas');
    expect(parseVillasTab('')).toBe('reservas');
    expect(parseVillasTab('ajustes')).toBe('reservas');
    expect(parseVillasTab('__proto__')).toBe('reservas');
  });

  it('acepta cada pestaña por su id y, si viene repetido, usa el primero', () => {
    for (const tab of VILLAS_TABS) expect(parseVillasTab(tab.id)).toBe(tab.id);
    expect(parseVillasTab(['cobros', 'web'])).toBe('cobros');
  });

  it('la pestaña por defecto es la ruta limpia: los correos enlazan /portal/villas a secas', () => {
    expect(DEFAULT_VILLAS_TAB).toBe('reservas');
    expect(villasTabHref('reservas')).toBe('/portal/villas');
    expect(villasTabHref('cobros')).toBe('/portal/villas?seccion=cobros');
  });

  it('la URL de cada pestaña vuelve a la misma pestaña', () => {
    for (const tab of VILLAS_TABS) {
      const url = new URL(villasTabHref(tab.id), 'https://portal.example');
      expect(parseVillasTab(url.searchParams.get('seccion'))).toBe(tab.id);
    }
  });

  it('las flechas recorren las pestañas y dan la vuelta en los extremos', () => {
    expect(neighbourVillasTab('reservas', 1)).toBe('villas');
    expect(neighbourVillasTab('reservas', -1)).toBe('web');
    expect(neighbourVillasTab('web', 1)).toBe('reservas');
  });
});
