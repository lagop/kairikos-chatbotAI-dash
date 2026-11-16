// =============================================================================
// 15/11/2026 — Recuperación de llamadas en español, inglés y alemán.
//
// Las piezas puras: qué idioma sugiere un número, cómo se escriben las horas,
// la baja en cada idioma, los acuses y las plantillas traducidas que se
// mandan a Meta. El envío de punta a punta está en recall-messaging.test.ts
// («idioma de quien llama»).
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  callerLanguageFor,
  languageForNumber,
  parseCallerLanguages,
  templateKey,
  CALLER_LANGUAGES,
} from '@/lib/recall-caller-language';
import { describeNextOpening, parseBusinessHours } from '@/lib/recall-hours';
import { formatSlotLabel, parseSlotChoice } from '@/lib/recall-slots';
import {
  isOptOutRequest,
  LEGAL_NOTICES,
  LEGAL_NOTICE_TEXT,
  LEGAL_NOTICE_VERSION,
  OPT_OUT_CONFIRMATIONS,
} from '@/lib/recall-optout';
import { callbackReplyText } from '@/lib/recall-callbacks';
import {
  CALLER_TEMPLATE_TRANSLATIONS,
  RECALL_TEMPLATE_DEFINITIONS,
  RECALL_OPTIONAL_TEMPLATE_DEFINITIONS,
  allRecallTemplateDefinitions,
  findTemplateTextDrift,
  missingTemplateDefinitions,
  summarizeTemplateApproval,
} from '@/lib/recall-templates';
import { RECALL_TEMPLATES } from '@/lib/recall-messaging';

describe('languageForNumber — el idioma que sugiere el prefijo', () => {
  it('alemán para Alemania, Austria, Suiza y Liechtenstein', () => {
    expect(languageForNumber('+4915112345678')).toBe('de');
    expect(languageForNumber('+436641234567')).toBe('de');
    expect(languageForNumber('+41791234567')).toBe('de');
    expect(languageForNumber('+4237812345')).toBe('de');
  });

  it('inglés para Reino Unido, Irlanda, +1, nórdicos y Países Bajos', () => {
    expect(languageForNumber('+447700900123')).toBe('en');
    expect(languageForNumber('+353871234567')).toBe('en');
    expect(languageForNumber('+12025550123')).toBe('en');
    expect(languageForNumber('+46701234567')).toBe('en');
    expect(languageForNumber('+31612345678')).toBe('en');
  });

  it('el prefijo más largo gana: Puerto Rico y República Dominicana son español', () => {
    expect(languageForNumber('+17875550123')).toBe('es');
    expect(languageForNumber('+18095550123')).toBe('es');
  });

  it('España es español; Francia o Italia, ninguno de los nuestros', () => {
    expect(languageForNumber('+34651234567')).toBe('es');
    expect(languageForNumber('+33612345678')).toBeNull();
    expect(languageForNumber('+393471234567')).toBeNull();
  });

  // Un número sin «+» no tiene prefijo internacional que leer: un 6… español
  // mal guardado no es Australia ni Nueva Zelanda.
  it('sin «+» o vacío, ninguno', () => {
    expect(languageForNumber('651234567')).toBeNull();
    expect(languageForNumber('')).toBeNull();
    expect(languageForNumber(null)).toBeNull();
  });
});

describe('callerLanguageFor — entre los idiomas activos del cliente', () => {
  it('usa el sugerido si el cliente lo tiene activo', () => {
    expect(callerLanguageFor('+4915112345678', ['es', 'de'])).toBe('de');
    expect(callerLanguageFor('+447700900123', ['es', 'en', 'de'])).toBe('en');
  });

  it('español si el sugerido no está activo, o si no hay sugerido', () => {
    expect(callerLanguageFor('+4915112345678', ['es'])).toBe('es');
    expect(callerLanguageFor('+447700900123', ['es', 'de'])).toBe('es');
    expect(callerLanguageFor('+33612345678', ['es', 'en', 'de'])).toBe('es');
  });
});

describe('parseCallerLanguages', () => {
  it('siempre con español, sin repetidos, en orden fijo y sin valores desconocidos', () => {
    expect(parseCallerLanguages(null)).toEqual(['es']);
    expect(parseCallerLanguages([])).toEqual(['es']);
    expect(parseCallerLanguages(['de', 'DE', 'fr', 'en', 7])).toEqual(['es', 'en', 'de']);
  });
});

describe('templateKey', () => {
  it('el español es el nombre a secas (como antes de los idiomas); el resto, nombre@idioma', () => {
    expect(templateKey('recall_caller_open_v2', 'es')).toBe('recall_caller_open_v2');
    expect(templateKey('recall_caller_open_v2', 'es_ES')).toBe('recall_caller_open_v2');
    expect(templateKey('recall_caller_open_v2', null)).toBe('recall_caller_open_v2');
    expect(templateKey('recall_caller_open_v2', 'de')).toBe('recall_caller_open_v2@de');
  });
});

describe('las horas en cada idioma', () => {
  const hours = parseBusinessHours(null); // horario por defecto
  // Martes 23:40 en Madrid: lo siguiente es el miércoles a las 8:00.
  const night = new Date('2026-07-07T21:40:00.000Z');

  it('describeNextOpening', () => {
    expect(describeNextOpening(hours, night, 'Europe/Madrid')).toBe('mañana a las 8:00');
    expect(describeNextOpening(hours, night, 'Europe/Madrid', 'en')).toBe('tomorrow at 8:00');
    expect(describeNextOpening(hours, night, 'Europe/Madrid', 'de')).toBe('morgen um 8:00 Uhr');
  });

  it('formatSlotLabel, también con día de la semana', () => {
    const now = new Date('2026-07-07T09:00:00.000Z'); // martes
    const friday = new Date('2026-07-10T09:00:00.000Z'); // 11:00 en Madrid
    expect(formatSlotLabel(friday, now, 'Europe/Madrid')).toBe('el viernes a las 11:00');
    expect(formatSlotLabel(friday, now, 'Europe/Madrid', 'en')).toBe('on Friday at 11:00');
    expect(formatSlotLabel(friday, now, 'Europe/Madrid', 'de')).toBe('am Freitag um 11:00 Uhr');
    expect(formatSlotLabel(now, now, 'Europe/Madrid', 'de')).toBe('heute um 11:00 Uhr');
  });

  it('parseSlotChoice entiende «ninguno» en alemán e inglés, y el número en cualquiera', () => {
    expect(parseSlotChoice('keine', 3)).toEqual({ kind: 'none' });
    expect(parseSlotChoice('Nein, danke', 3)).toEqual({ kind: 'none' });
    expect(parseSlotChoice('neither', 3)).toEqual({ kind: 'none' });
    expect(parseSlotChoice('Nummer 2 bitte', 3)).toEqual({ kind: 'slot', index: 2 });
    expect(parseSlotChoice('the 3rd one', 3)).toEqual({ kind: 'slot', index: 3 });
  });
});

describe('la baja en cada idioma', () => {
  it('el español no cambia: misma versión, mismo texto', () => {
    expect(LEGAL_NOTICES.es).toEqual({ version: '2026-09-v1', text: LEGAL_NOTICE_TEXT });
    expect(LEGAL_NOTICE_VERSION).toBe('2026-09-v1');
  });

  it('cada idioma tiene su propia versión del aviso (la columna dice por sí sola qué texto se leyó)', () => {
    const versions = CALLER_LANGUAGES.map((l) => LEGAL_NOTICES[l].version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  // Lo que el aviso pide contestar tiene que darse de baja de verdad.
  it('la palabra que pide cada aviso se reconoce como baja', () => {
    expect(isOptOutRequest('BAJA')).toBe(true);
    expect(isOptOutRequest('STOP')).toBe(true);
    expect(isOptOutRequest('STOPP')).toBe(true);
    expect(LEGAL_NOTICES.en.text).toContain('STOP');
    expect(LEGAL_NOTICES.de.text).toContain('STOPP');
  });

  it('y otras formas razonables en inglés y alemán', () => {
    for (const text of [
      'Abmelden',
      'bitte abbestellen',
      'Bitte keine Nachrichten mehr',
      'Stop messaging me',
      "Don't message me",
      'unsubscribe please',
    ]) {
      expect(isOptOutRequest(text), text).toBe(true);
    }
  });

  it('pero no una frase larga que pide justo lo contrario', () => {
    expect(isOptOutRequest('Ich kann heute nicht, rufen Sie mich bitte morgen um 10 an')).toBe(false);
    expect(isOptOutRequest("I can't talk now, please call me back tomorrow")).toBe(false);
  });

  it('hay confirmación en cada idioma', () => {
    for (const lang of CALLER_LANGUAGES) expect(OPT_OUT_CONFIRMATIONS[lang]).toBeTruthy();
  });
});

describe('callbackReplyText en cada idioma', () => {
  const slot = { at: new Date('2026-07-08T07:00:00.000Z'), label: 'morgen um 9:00 Uhr' };

  it('en alemán', () => {
    expect(callbackReplyText({ status: 'scheduled', slot, language: 'de' }, 'Hotel Aurora')).toBe(
      'Erledigt: Wir rufen Sie morgen um 9:00 Uhr an. Falls etwas dazwischenkommt, schreiben Sie uns einfach hier.',
    );
    expect(callbackReplyText({ status: 'unclear', language: 'de' }, 'Hotel Aurora')).toContain('(1, 2 oder 3)');
  });

  it('en inglés', () => {
    expect(
      callbackReplyText({ status: 'scheduled', slot: { ...slot, label: 'tomorrow at 9:00' }, language: 'en' }, 'x'),
    ).toBe("Done: we'll call you tomorrow at 9:00. If anything comes up, write to us here.");
    expect(callbackReplyText({ status: 'declined', language: 'en' }, 'Hotel Aurora')).toContain('from Hotel Aurora');
  });

  it('en español, igual que siempre', () => {
    expect(callbackReplyText({ status: 'declined', language: 'es' }, 'Hotel Aurora')).toBe(
      'Sin problema. Dinos a qué hora te viene bien y te llamamos desde Hotel Aurora.',
    );
  });

  it("'ignored' no se contesta", () => {
    expect(callbackReplyText({ status: 'ignored', reason: 'no_open_offer' }, 'x')).toBeNull();
  });
});

describe('plantillas de primer contacto traducidas', () => {
  const spanish = [...RECALL_TEMPLATE_DEFINITIONS, ...RECALL_OPTIONAL_TEMPLATE_DEFINITIONS];
  const placeholders = (text: string) => text.match(/\{\{\d+\}\}/g) ?? [];

  it('en inglés y alemán, las tres versiones con aviso, con su mismo nombre', () => {
    const expected = [
      RECALL_TEMPLATES.callerOpenWithNotice.name,
      RECALL_TEMPLATES.callerClosedWithNotice.name,
      RECALL_TEMPLATES.callerSlotsWithNotice.name,
    ];
    expect(Object.keys(CALLER_TEMPLATE_TRANSLATIONS).sort()).toEqual(['de', 'en']);
    for (const [lang, defs] of Object.entries(CALLER_TEMPLATE_TRANSLATIONS)) {
      expect(defs.map((d) => d.name)).toEqual(expected);
      for (const def of defs) expect(def.languageCode).toBe(lang);
    }
  });

  // Los parámetros son un contrato con lo que se envía: el mismo número y
  // orden que la española, o Meta rechaza el envío con 132000.
  it('mismos parámetros que la española, un ejemplo por parámetro, y el aviso de su idioma al final', () => {
    for (const [lang, defs] of Object.entries(CALLER_TEMPLATE_TRANSLATIONS)) {
      for (const def of defs) {
        const es = spanish.find((d) => d.name === def.name)!;
        expect(placeholders(def.bodyText), `${def.name}@${lang}`).toEqual(placeholders(es.bodyText));
        expect(def.bodyExamples).toHaveLength(placeholders(def.bodyText).length);
        expect(def.bodyText.endsWith(LEGAL_NOTICES[lang as 'en' | 'de'].text)).toBe(true);
        expect(def.category).toBe(es.category);
        // Meta: una variable no puede ir ni al principio ni al final (2388299).
        expect(def.bodyText.trim()).not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}$/);
        expect(def.bodyText).not.toMatch(/\{\{\d+\}\}\s*\{\{\d+\}\}/);
      }
    }
  });

  it('las obligatorias del alta siguen siendo todas españolas', () => {
    for (const def of RECALL_TEMPLATE_DEFINITIONS) expect(def.languageCode).toBe('es');
  });

  // Lo que hace que un cliente que no toca nada siga exactamente igual.
  it('sin idiomas activos no se piden traducciones a Meta', () => {
    const base = allRecallTemplateDefinitions('https://portal.example');
    expect(base.every((d) => d.languageCode === 'es')).toBe(true);
    expect(allRecallTemplateDefinitions('https://portal.example', ['es'])).toEqual(base);
  });

  it('con el alemán activo faltan exactamente sus tres traducciones', () => {
    const allSpanish = new Set(allRecallTemplateDefinitions('https://portal.example').map((d) => d.name));
    const missing = missingTemplateDefinitions(allSpanish, 'https://portal.example', ['es', 'de']);
    expect(missing.map((d) => `${d.name}@${d.languageCode}`)).toEqual([
      'recall_caller_open_v2@de',
      'recall_caller_closed_v2@de',
      'recall_caller_slots_v2@de',
    ]);
    // Y una vez enviadas, ya no faltan.
    const withGerman = new Set([...allSpanish, ...missing.map((d) => `${d.name}@de`)]);
    expect(missingTemplateDefinitions(withGerman, 'https://portal.example', ['es', 'de'])).toEqual([]);
  });

  it('el desvío de texto compara cada traducción con la suya, no con la española', () => {
    const defs = allRecallTemplateDefinitions('https://portal.example', CALLER_LANGUAGES);
    const de = CALLER_TEMPLATE_TRANSLATIONS.de[0];
    const es = RECALL_TEMPLATE_DEFINITIONS.find((d) => d.name === de.name)!;
    const meta = (language: string, text: string) => ({ name: de.name, language, components: [{ type: 'BODY', text }] });

    expect(findTemplateTextDrift([meta('de', de.bodyText), meta('es', es.bodyText)], defs)).toEqual([]);
    const broken = findTemplateTextDrift([meta('de', de.bodyText.replace('ö', '?'))], defs);
    expect(broken).toHaveLength(1);
    expect(broken[0].expected).toBe(de.bodyText);
  });

  it('el resumen de la cola distingue la traducción de la española', () => {
    const s = summarizeTemplateApproval(
      [
        { name: 'recall_caller_open_v2', languageCode: 'es', status: 'APPROVED', rejectedReason: null },
        { name: 'recall_caller_open_v2', languageCode: 'de', status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' },
      ],
      { required: ['recall_caller_open_v2'], optional: ['recall_caller_open_v2@de'] },
    );
    expect(s.required.approved).toBe(1);
    expect(s.optional).toEqual({ approved: 0, total: 1 });
    expect(s.problems).toEqual([
      { name: 'recall_caller_open_v2', languageCode: 'de', status: 'REJECTED', reason: 'INVALID_FORMAT', required: false },
    ]);
  });
});
