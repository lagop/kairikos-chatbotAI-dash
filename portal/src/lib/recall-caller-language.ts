// =============================================================================
// 15/11/2026 — en qué idioma se le escribe a quien llamó.
//
// Hasta hoy todo salía en español. Un hotel o una clínica con clientes
// extranjeros recibe llamadas de números alemanes o británicos, y a esa
// persona un «Hola, soy el asistente de…» le dice poco. Ahora el primer
// mensaje (y lo que se le contesta después: el acuse del hueco elegido, la
// confirmación de baja) sale en el idioma que sugiere el prefijo del número.
//
// TRES REGLAS
//
//   1. El español es el idioma por defecto y está SIEMPRE activo. Un número
//      sin prefijo reconocible, o de un país cuyo idioma el cliente no ha
//      activado, recibe español, igual que antes.
//   2. Qué idiomas usa cada cliente lo decide el operador
//      (RecallSubscription.callerLanguages). Por defecto solo español: un
//      cliente que no lo toca sigue exactamente igual, y no se le manda a
//      Meta ninguna plantilla nueva.
//   3. Elegir el idioma no basta para enviarlo: la plantilla de ese idioma
//      tiene que estar APROBADA por Meta (ver chooseCallerTemplate en
//      recall-messaging.ts). Mientras no lo está, se envía la española.
//
// El prefijo es una aproximación, y se sabe: un residente alemán en Gran
// Canaria con número español recibe español, y un turista español con número
// alemán recibe alemán. Para un primer mensaje es suficiente; la
// conversación que sigue la lleva el chatbot en el idioma en que le escriban.
// =============================================================================

export const CALLER_LANGUAGES = ['es', 'en', 'de'] as const;
export type CallerLanguage = (typeof CALLER_LANGUAGES)[number];

/** Nombres para el panel del operador. */
export const CALLER_LANGUAGE_LABEL: Readonly<Record<CallerLanguage, string>> = {
  es: 'Español',
  en: 'Inglés',
  de: 'Alemán',
};

export function isCallerLanguage(value: unknown): value is CallerLanguage {
  return typeof value === 'string' && (CALLER_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Los idiomas activos de un cliente, tal y como se guardan en la base.
 *
 * Tolerante con lo que haya en la columna: ignora valores desconocidos y
 * repetidos, pone el español siempre (regla 1) y devuelve el orden canónico
 * de CALLER_LANGUAGES, para que dos listas iguales se comparen iguales.
 */
export function parseCallerLanguages(value: unknown): CallerLanguage[] {
  const wanted = new Set<CallerLanguage>(['es']);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const code = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
      if (isCallerLanguage(code)) wanted.add(code);
    }
  }
  return CALLER_LANGUAGES.filter((lang) => wanted.has(lang));
}

/**
 * Prefijos internacionales (sin el «+») y el idioma que sugieren.
 *
 * Gana el prefijo MÁS LARGO que coincida: así +1 787 (Puerto Rico) es
 * español aunque +1 sea inglés.
 *
 * Inglés para los países de habla inglesa y, además, para los nórdicos y los
 * Países Bajos: allí el inglés es la segunda lengua habitual, son buena parte
 * del turismo extranjero en Canarias, y un mensaje en inglés se entiende
 * mejor que uno en español. Los países con varias lenguas oficiales donde
 * ninguna de las nuestras domina (Bélgica, Luxemburgo) se quedan fuera: caen
 * en español, que es la regla por defecto.
 */
const PREFIX_LANGUAGE: ReadonlyArray<readonly [string, CallerLanguage]> = [
  // Alemán
  ['49', 'de'], // Alemania
  ['43', 'de'], // Austria
  ['41', 'de'], // Suiza (mayoría germanohablante)
  ['423', 'de'], // Liechtenstein
  // Inglés
  ['44', 'en'], // Reino Unido
  ['353', 'en'], // Irlanda
  ['1', 'en'], // Estados Unidos, Canadá y el resto del plan +1
  ['61', 'en'], // Australia
  ['64', 'en'], // Nueva Zelanda
  ['27', 'en'], // Sudáfrica
  ['356', 'en'], // Malta
  ['350', 'en'], // Gibraltar
  ['31', 'en'], // Países Bajos
  ['45', 'en'], // Dinamarca
  ['46', 'en'], // Suecia
  ['47', 'en'], // Noruega
  ['358', 'en'], // Finlandia
  ['354', 'en'], // Islandia
  // Español dentro del plan +1: Puerto Rico y República Dominicana.
  ['1787', 'es'],
  ['1939', 'es'],
  ['1809', 'es'],
  ['1829', 'es'],
  ['1849', 'es'],
];

const PREFIXES_LONGEST_FIRST = [...PREFIX_LANGUAGE].sort((a, b) => b[0].length - a[0].length);

/**
 * El idioma que sugiere el prefijo de un número E.164, o null si no sugiere
 * ninguno de los nuestros (España, Francia, un número sin «+»…).
 */
export function languageForNumber(e164: string | null | undefined): CallerLanguage | null {
  const raw = String(e164 ?? '').trim();
  // Sin «+» no hay prefijo internacional que leer: un número nacional
  // español mal guardado no debe leerse como +6… o +4….
  if (!raw.startsWith('+')) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('34')) return 'es';
  for (const [prefix, lang] of PREFIXES_LONGEST_FIRST) {
    if (digits.startsWith(prefix)) return lang;
  }
  return null;
}

/**
 * Cómo se identifica una plantilla de WhatsApp en los conjuntos de «ya
 * enviada» o «aprobada» (recall-templates.ts, recall-messaging.ts): el nombre
 * para el español y `nombre@idioma` para el resto. En Meta una plantilla es un
 * nombre con una traducción por idioma, así que el nombre solo ya no basta.
 *
 * El español va sin sufijo a propósito: es lo que esos conjuntos guardaban
 * antes de que hubiera idiomas, así que todo lo que ya los construía con
 * nombres sueltos sigue significando lo mismo.
 */
export function templateKey(name: string, languageCode: string | null | undefined): string {
  // 'es_ES' también es español: alguna plantilla antigua pudo darse de alta a
  // mano así, y antes de los idiomas contaba por su nombre.
  const spanish = !languageCode || languageCode === 'es' || languageCode.startsWith('es_');
  return spanish ? name : `${name}@${languageCode}`;
}

/**
 * El idioma en que se le escribe a este número, entre los activos del
 * cliente. Español si el prefijo no sugiere ninguno o si el sugerido no está
 * activo.
 */
export function callerLanguageFor(e164: string | null | undefined, active: readonly CallerLanguage[]): CallerLanguage {
  const suggested = languageForNumber(e164);
  return suggested && active.includes(suggested) ? suggested : 'es';
}
