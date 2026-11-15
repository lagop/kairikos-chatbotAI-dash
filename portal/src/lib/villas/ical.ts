import { addDays, isIsoDate, type IsoDate } from './dates';

// =============================================================================
// Reserva propia para villas — leer y escribir calendarios iCal (RFC 5545).
//
// Solo lo que hace falta para sincronizar ocupación con Airbnb y Booking, que
// exportan VEVENT de día completo (DTSTART;VALUE=DATE) con la salida en DTEND.
// No es un parser general de iCalendar: no expande RRULE (ninguna de las dos
// plataformas las usa para reservas) ni interpreta zonas horarias.
//
// Con fecha y hora (DTSTART:20261214T150000Z, o con TZID) se toma el día tal
// como viene escrito. Para una noche de villa basta, y evitar convertir zonas
// es evitar que una reserva se corra de día por la hora del servidor.
//
// Pura: sin red ni base de datos. La lectura por HTTP está en ical-sync.ts.
// =============================================================================

export interface IcalEvent {
  uid: string | null;
  start: IsoDate;
  /** Salida (no ocupada). */
  end: IsoDate;
  summary: string | null;
}

/** Un calendario de una villa con más eventos que esto no es un calendario de
 *  una villa: se corta para que una URL equivocada no llene la tabla. */
export const MAX_EVENTS = 2000;

function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** 'DTSTART;VALUE=DATE:20261214' → { name: 'DTSTART', params: 'VALUE=DATE', value: '20261214' }.
 *  Los dos puntos de un parámetro entre comillas no cortan. */
function splitProperty(line: string): { name: string; params: string; value: string } | null {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      const head = line.slice(0, i);
      const semi = head.indexOf(';');
      return {
        name: (semi === -1 ? head : head.slice(0, semi)).toUpperCase(),
        params: semi === -1 ? '' : head.slice(semi + 1),
        value: line.slice(i + 1),
      };
    }
  }
  return null;
}

/** '20261214' o '20261214T150000Z' → '2026-12-14'. */
function parseIcalDate(value: string): IsoDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isIsoDate(iso) ? iso : null;
}

/** Solo días y semanas ('P3D', 'P1W'); una DURATION con horas cuenta como un día. */
function durationDays(value: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?/.exec(value.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0);
}

export function parseIcs(text: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        const event = toEvent(current);
        if (event) events.push(event);
        if (events.length >= MAX_EVENTS) break;
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    // La primera aparición gana (un VEVENT bien formado no repite estas).
    if (!(prop.name in current)) current[prop.name] = prop.value;
  }
  return events;
}

function toEvent(props: Record<string, string>): IcalEvent | null {
  if ((props.STATUS ?? '').trim().toUpperCase() === 'CANCELLED') return null;
  const start = props.DTSTART ? parseIcalDate(props.DTSTART) : null;
  if (!start) return null;
  let end = props.DTEND ? parseIcalDate(props.DTEND) : null;
  if (!end && props.DURATION) {
    const days = durationDays(props.DURATION);
    if (days !== null) end = addDays(start, Math.max(1, days));
  }
  // Sin fin, o con un fin que no avanza: una noche (RFC 5545 §3.6.1, evento de día).
  if (!end || end <= start) end = addDays(start, 1);
  return {
    uid: props.UID ? props.UID.trim() : null,
    start,
    end,
    summary: props.SUMMARY ? unescapeText(props.SUMMARY.trim()) : null,
  };
}

// --- Salida ------------------------------------------------------------------

export interface ExportEvent {
  uid: string;
  start: IsoDate;
  end: IsoDate;
  summary: string;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Corta a 75 octetos por línea (RFC 5545 §3.1), sin partir un carácter UTF-8. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // las de continuación empiezan con un espacio
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const icalDate = (iso: IsoDate) => iso.replace(/-/g, '');

function icalStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildIcs(calendarName: string, events: readonly ExportEvent[], now: Date = new Date()): string {
  const stamp = icalStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kairikos//Reserva de villas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(e.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icalDate(e.start)}`,
      `DTEND;VALUE=DATE:${icalDate(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
