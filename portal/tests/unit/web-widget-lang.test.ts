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
  widgetPrivacyFromConfig,
  isKnownWidgetContactNoticeVersion,
  WIDGET_CONTACT_NOTICE_VERSION,
  WIDGET_CONTACT_NOTICES,
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

// =============================================================================
// Aviso de privacidad del formulario de contacto (25/11/2026).
// =============================================================================

describe('widgetPrivacyFromConfig', () => {
  it('URL y responsable del paso 10', () => {
    expect(
      widgetPrivacyFromConfig({
        responsable_tratamiento: '  Clínica Orly, S.L. ',
        url_politica_privacidad: 'https://www.clinica.example/privacidad',
      }),
    ).toEqual({ url: 'https://www.clinica.example/privacidad', controller: 'Clínica Orly, S.L.' });
  });

  it('sin paso 10 (bloque vacío o ausente), null', () => {
    expect(widgetPrivacyFromConfig({})).toBeNull();
    expect(widgetPrivacyFromConfig(undefined)).toBeNull();
  });

  it('una URL que no es http(s) no sale; el responsable sí', () => {
    expect(widgetPrivacyFromConfig({ responsable_tratamiento: 'X', url_politica_privacidad: 'javascript:alert(1)' })).toEqual({
      url: null,
      controller: 'X',
    });
  });

  it('quita saltos de línea del responsable: va dentro de una frase', () => {
    expect(widgetPrivacyFromConfig({ responsable_tratamiento: 'Orly\nS.L.' })?.controller).toBe('Orly S.L.');
  });
});

describe('isKnownWidgetContactNoticeVersion', () => {
  it('solo las versiones publicadas', () => {
    expect(isKnownWidgetContactNoticeVersion(WIDGET_CONTACT_NOTICE_VERSION)).toBe(true);
    expect(isKnownWidgetContactNoticeVersion('2099-01-v1')).toBe(false);
    expect(isKnownWidgetContactNoticeVersion('constructor')).toBe(false);
    expect(isKnownWidgetContactNoticeVersion(undefined)).toBe(false);
  });

  it('cada versión tiene los tres idiomas del widget con los cuatro textos', () => {
    for (const [version, langs] of Object.entries(WIDGET_CONTACT_NOTICES)) {
      expect(Object.keys(langs).sort(), version).toEqual([...WIDGET_LANGS].sort());
      for (const t of Object.values(langs)) {
        for (const v of [t.notice, t.consent, t.privacyLink, t.consentMissing]) expect(v.trim()).not.toBe('');
      }
    }
  });
});
