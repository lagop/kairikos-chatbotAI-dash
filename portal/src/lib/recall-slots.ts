import { isWithinBusinessHours, type BusinessHours } from './recall-hours';

// =============================================================================
// Fase 3 — huecos para devolver la llamada.
//
// Hasta ahora, a quien llamaba y no le cogían se le mandaba un WhatsApp
// que decía «te llamamos enseguida» o «abrimos el lunes a las 8:00». Las
// dos son promesas sin hora. Esto le deja elegir CUÁNDO le devuelven la
// llamada, contestando un número al mismo WhatsApp.
//
// **Un hueco es una devolución de llamada, no una cita.** El portal no
// conoce la agenda del negocio: no sabe si el martes a las 11:00 el dueño
// está en una obra. Ofrecer «citas» sería inventarse una disponibilidad
// que no tenemos, y el dueño quedaría mal por una promesa que hicimos
// nosotros. Lo que sí podemos comprometer es a qué hora le llamamos,
// porque el que llama es él y el hueco solo dice cuándo.
//
// Deliberadamente SIN `server-only` y sin Prisma, igual que
// recall-hours.ts: todo aquí es puro, así que los tests ejercitan la
// lógica de verdad y no un mock de ella.
//
// La aritmética de zonas horarias se esquiva por completo: en vez de
// CONSTRUIR «el martes a las 9:00 en Madrid» —que es donde se cuela el
// error de horario de verano— se avanza en saltos de media hora desde
// ahora y se le pregunta a isWithinBusinessHours si cada instante cae
// dentro. Son 144 comprobaciones para tres días, y ninguna necesita saber
// qué offset tiene esa zona hoy.
// =============================================================================

/** Rejilla de la oferta. Media hora es el grano al que la gente piensa una
 *  llamada; quince minutos daría el doble de opciones sin que ninguna sea
 *  mejor. */
export const SLOT_GRANULARITY_MINUTES = 30;

/** Nadie quiere elegir «dentro de dos minutos». Además da margen a que el
 *  dueño vea el aviso antes del primer hueco posible. */
export const SLOT_LEAD_MINUTES = 45;

/** Hasta dónde se mira hacia delante. Más de tres días y el primer hueco
 *  ya no responde a la llamada que acaba de hacer. */
export const SLOT_HORIZON_DAYS = 3;

/** Separación mínima entre las opciones ofrecidas. Ofrecer «10:00, 10:30 y
 *  11:00» no es elegir: son la misma hora tres veces. Dos horas obliga a
 *  que las tres opciones sean de verdad distintas. */
export const SLOT_SPACING_MINUTES = 120;

/** Tres opciones. Con dos no hay dónde elegir si ninguna vale, y con más
 *  la lista deja de caber en un mensaje que se lee de un vistazo. */
export const MAX_OFFERED_SLOTS = 3;

/** Por debajo de esto no se ofrece nada y se manda el mensaje de siempre:
 *  una única «opción» no es una elección, es el mensaje de antes con un
 *  paso de más. */
export const MIN_OFFERED_SLOTS = 2;

export interface CallbackSlot {
  /** Instante UTC del hueco. */
  at: Date;
  /** Cómo se le enseña a quien llamó: 'hoy a las 17:30'. */
  label: string;
}

const DAY_LABEL: readonly string[] = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

interface ZonedParts {
  /** 'YYYY-MM-DD' local, para comparar días sin tocar husos. */
  date: string;
  hour: number;
  minute: number;
  /** 0 = domingo, como getUTCDay. */
  weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function zonedParts(at: Date, timezone: string): ZonedParts {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

  let parts;
  try {
    parts = format(timezone);
  } catch {
    // Una zona IANA desconocida no puede tumbar el barrido — misma
    // postura que getZoned en recall-hours.ts.
    parts = format('UTC');
  }

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // '24' aparece a medianoche en algunas compilaciones de ICU.
    hour: Number(get('hour') || '0') % 24,
    minute: Number(get('minute') || '0'),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 1,
  };
}

/**
 * 'hoy a las 17:30' | 'mañana a las 9:00' | 'el martes a las 11:00'.
 *
 * Mismo registro que describeNextOpening en recall-hours.ts: lo lee un
 * desconocido en un WhatsApp, no un operador en un panel.
 */
export function formatSlotLabel(at: Date, now: Date, timezone: string): string {
  const slot = zonedParts(at, timezone);
  const today = zonedParts(now, timezone).date;
  const time = `${slot.hour}:${String(slot.minute).padStart(2, '0')}`;

  if (slot.date === today) return `hoy a las ${time}`;

  // Mañana es el día local siguiente. Se compara por cadena de fecha, no
  // sumando 24 horas, que en el cambio de hora no da el día siguiente.
  const tomorrow = zonedParts(new Date(now.getTime() + 24 * 60 * 60_000), timezone).date;
  if (slot.date === tomorrow) return `mañana a las ${time}`;

  return `el ${DAY_LABEL[slot.weekday]} a las ${time}`;
}

/** El primer instante de la rejilla que está al menos SLOT_LEAD_MINUTES
 *  por delante. Se redondea sobre el reloj UTC: las zonas de media hora
 *  (India) desplazarían la rejilla, pero este producto vende en España y
 *  un hueco a las 17:00 o a las 17:30 da igual mientras sea estable. */
function firstCandidate(now: Date): Date {
  const step = SLOT_GRANULARITY_MINUTES * 60_000;
  const earliest = now.getTime() + SLOT_LEAD_MINUTES * 60_000;
  return new Date(Math.ceil(earliest / step) * step);
}

export interface BuildSlotsOptions {
  /** Huecos ya comprometidos con otra persona, para no ofrecer el mismo
   *  dos veces. Se comparan por instante exacto, que es lo que se guarda. */
  taken?: readonly Date[];
  max?: number;
}

/**
 * Los huecos que se le ofrecen a quien llamó.
 *
 * Devuelve como mucho `max` opciones, separadas entre sí al menos
 * SLOT_SPACING_MINUTES, todas dentro del horario del negocio y ninguna
 * antes de SLOT_LEAD_MINUTES desde ahora. Lista vacía cuando el negocio no
 * abre en los próximos SLOT_HORIZON_DAYS días: el que llama recibe
 * entonces el mensaje de siempre, no una oferta vacía.
 */
export function buildCallbackSlots(
  hours: BusinessHours,
  now: Date,
  timezone: string,
  options: BuildSlotsOptions = {},
): CallbackSlot[] {
  const max = options.max ?? MAX_OFFERED_SLOTS;
  if (max <= 0) return [];

  const takenMs = new Set((options.taken ?? []).map((d) => d.getTime()));
  const step = SLOT_GRANULARITY_MINUTES * 60_000;
  const horizonMs = now.getTime() + SLOT_HORIZON_DAYS * 24 * 60 * 60_000;
  const spacingMs = SLOT_SPACING_MINUTES * 60_000;

  const slots: CallbackSlot[] = [];
  let cursor = firstCandidate(now);
  let lastPicked: number | null = null;

  while (cursor.getTime() <= horizonMs && slots.length < max) {
    const ms = cursor.getTime();
    const spacedEnough = lastPicked === null || ms - lastPicked >= spacingMs;

    if (spacedEnough && !takenMs.has(ms) && isWithinBusinessHours(hours, cursor, timezone)) {
      slots.push({ at: cursor, label: formatSlotLabel(cursor, now, timezone) });
      lastPicked = ms;
    }

    cursor = new Date(ms + step);
  }

  return slots;
}

/**
 * La lista numerada que viaja en el parámetro de la plantilla.
 *
 * Separada por ' · ' y NUNCA por saltos de línea: Meta rechaza el envío
 * entero con «Param text cannot have new-line/tab characters», un 400 que
 * no se reintenta, así que un '\n' aquí significa que el mensaje no llega
 * nunca. Es la misma restricción que ya documenta buildDigestList.
 */
export function buildSlotList(slots: readonly CallbackSlot[]): string {
  return slots.map((slot, index) => `${index + 1}) ${slot.label}`).join(' · ');
}

// ---------------------------------------------------------------------------
// La respuesta de quien llamó
// ---------------------------------------------------------------------------

export type SlotChoice =
  | { kind: 'slot'; index: number }
  | { kind: 'none' }
  | { kind: 'unclear' };

/** Palabras con las que alguien dice que no le vale ninguna. Sin acentos y
 *  de una sola palabra, porque se comparan después de normalizar — igual
 *  que NONE_WORDS en recall-digest.ts. */
const NONE_WORDS = ['ninguno', 'ninguna', 'ningun', 'nada', 'no', 'cero', 'none'];

/**
 * Lee lo que de verdad escribió quien llamó.
 *
 * Igual de permisivo que parseDigestReply y por la misma razón: es una
 * persona contestando un WhatsApp, no rellenando un formulario. «2», «el
 * 2», «la segunda no, la 2», «me viene bien la 3».
 *
 * Se queda con el PRIMER número válido, no con el último ni con todos:
 * esto es una elección única, y quien escribe «la 1 o la 2» está diciendo
 * que le vale antes la primera. Un número fuera de rango se ignora, y solo
 * un mensaje sin ningún número usable sale 'unclear'.
 *
 * **Una negación gana sobre el número que la acompaña.** «no puedo el 2»
 * es un rechazo y «el 2 no, el 3» es una corrección, y separarlos exige
 * entender la frase, no reconocer palabras. Se elige el rechazo porque los
 * dos errores no cuestan lo mismo: leer un rechazo como elección le promete
 * a alguien una llamada a una hora que acaba de decir que no le viene bien
 * —y el dueño llama y queda mal—, mientras que leer una corrección como
 * rechazo solo lleva a pedirle que nos diga él la hora. Es la misma postura
 * que el resto del módulo: ante la duda, no prometer.
 */
export function parseSlotChoice(raw: string, count: number): SlotChoice {
  const text = raw
    .toLowerCase()
    .normalize('NFD')
    // Quita los acentos, para que 'ningún' y 'ningun' sean la misma palabra.
    .replace(/[̀-ͯ]/g, '')
    .trim();

  if (!text) return { kind: 'unclear' };

  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 0 && words.every((w) => w === '0')) return { kind: 'none' };
  if (words.some((w) => NONE_WORDS.includes(w))) return { kind: 'none' };

  for (const match of text.matchAll(/\d+/g)) {
    const value = Number(match[0]);
    if (Number.isInteger(value) && value >= 1 && value <= count) {
      return { kind: 'slot', index: value };
    }
  }

  return { kind: 'unclear' };
}

// ---------------------------------------------------------------------------
// Ida y vuelta con la columna Json
// ---------------------------------------------------------------------------

export interface StoredSlot {
  at: string;
  label: string;
}

export function slotsToJson(slots: readonly CallbackSlot[]): StoredSlot[] {
  return slots.map((slot) => ({ at: slot.at.toISOString(), label: slot.label }));
}

/**
 * Relee los huecos ofrecidos tal y como se guardaron.
 *
 * El orden se lee del array almacenado y NUNCA se recalcula: volver a
 * construir la lista media hora después daría otras horas, y el «2» de
 * quien llamó se resolvería a un hueco distinto del que vio. Es el mismo
 * motivo por el que resolveSelection lee el orden guardado del digest.
 *
 * Tolerante con lo que haya en la columna: es un Json libre y una fila
 * corrupta no puede tumbar la respuesta a una persona que está esperando.
 */
export function slotsFromJson(value: unknown): CallbackSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: CallbackSlot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { at, label } = entry as Record<string, unknown>;
    if (typeof at !== 'string' || typeof label !== 'string') continue;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) continue;
    slots.push({ at: date, label });
  }
  return slots;
}
