// =============================================================================
// Widget v2 — idioma en la configuración (`?lang=` de
// /api/public/channels/web/config): aviso de datos de salud y saludo por
// defecto. Alemán desde el 15/11/2026.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WELCOME,
  SENSITIVE_DATA_NOTICE,
  WIDGET_LANGS,
  parseWidgetLang,
  sensitiveDataNoticeFor,
  welcomeMessageFor,
} from '@/lib/web-widget-context';

describe('parseWidgetLang', () => {
  it('reconoce es, en y de', () => {
    expect(parseWidgetLang('es')).toBe('es');
    expect(parseWidgetLang('en')).toBe('en');
    expect(parseWidgetLang('de')).toBe('de');
  });

  it('sin parámetro o con un idioma desconocido, español', () => {
    expect(parseWidgetLang(null)).toBe('es');
    expect(parseWidgetLang(undefined)).toBe('es');
    expect(parseWidgetLang('')).toBe('es');
    expect(parseWidgetLang('fr')).toBe('es');
    expect(parseWidgetLang('toString')).toBe('es');
  });

  it('acepta región y mayúsculas', () => {
    expect(parseWidgetLang('de-AT')).toBe('de');
    expect(parseWidgetLang(' EN ')).toBe('en');
  });
});

describe('sensitiveDataNoticeFor', () => {
  const clinica = { vertical: 'clinica' };

  it('hay aviso en cada idioma del widget', () => {
    for (const lang of WIDGET_LANGS) expect(SENSITIVE_DATA_NOTICE[lang]).toBeTruthy();
  });

  it('en una clínica, en el idioma pedido', () => {
    expect(sensitiveDataNoticeFor(clinica, null)).toBe(SENSITIVE_DATA_NOTICE.es);
    expect(sensitiveDataNoticeFor(clinica, 'en')).toBe(SENSITIVE_DATA_NOTICE.en);
    expect(sensitiveDataNoticeFor(clinica, 'de')).toBe(SENSITIVE_DATA_NOTICE.de);
    expect(sensitiveDataNoticeFor(clinica, 'fr')).toBe(SENSITIVE_DATA_NOTICE.es);
  });

  it('fuera de clínicas, ninguno en ningún idioma', () => {
    expect(sensitiveDataNoticeFor({ vertical: 'hotel' }, 'de')).toBeNull();
    expect(sensitiveDataNoticeFor({}, 'en')).toBeNull();
  });
});

describe('welcomeMessageFor', () => {
  it('el saludo por defecto sale en el idioma de la web', () => {
    expect(welcomeMessageFor(DEFAULT_WELCOME.es, 'de')).toBe('Hallo! Wie kann ich Ihnen helfen?');
    expect(welcomeMessageFor(DEFAULT_WELCOME.es, 'en')).toBe(DEFAULT_WELCOME.en);
    expect(welcomeMessageFor(DEFAULT_WELCOME.es, null)).toBe(DEFAULT_WELCOME.es);
  });

  it('el saludo que escribió el negocio no se toca', () => {
    const propio = '¡Bienvenido a Sombra Buena! ¿Buscas fechas?';
    expect(welcomeMessageFor(propio, 'de')).toBe(propio);
    expect(welcomeMessageFor(propio, 'en')).toBe(propio);
  });
});
