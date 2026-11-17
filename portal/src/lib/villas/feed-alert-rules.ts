// =============================================================================
// Reserva propia para villas — cuándo avisar de un calendario que no se lee.
//
// Si el iCal de Airbnb o Booking deja de leerse (URL regenerada, anuncio
// borrado, la plataforma caída), el portal se queda con los bloqueos de la
// última lectura buena: no abre fechas por un fallo, pero tampoco ve las
// reservas nuevas. Hasta ahora eso solo salía en el panel, y el dueño no entra
// a mirarlo si no tiene solicitudes. Un aviso por correo, una vez por racha.
//
// Pura y sin 'server-only': la usan el cron (feed-alerts.ts) y el panel, que
// enseña el mismo texto del error.
// =============================================================================

/**
 * Cuánto tiene que durar la racha antes de avisar. El cron lee cada 30 min,
 * así que son unas seis lecturas fallidas: un corte puntual de Booking no
 * manda correos, una URL que ya no existe sí, en la misma mañana.
 */
export const FEED_ALERT_AFTER_HOURS = 3;

export interface FeedAlertState {
  lastStatus: string | null;
  errorSince: Date | null;
  alertedAt: Date | null;
}

/** ¿Toca avisar de este calendario? Una vez por racha: `alertedAt` se vacía al leer bien. */
export function feedNeedsAlert(feed: FeedAlertState, now: Date): boolean {
  if (feed.lastStatus !== 'error' || !feed.errorSince || feed.alertedAt) return false;
  return now.getTime() - feed.errorSince.getTime() >= FEED_ALERT_AFTER_HOURS * 3_600_000;
}

/** El límite para buscarlos en la base de datos: los que fallan desde antes de esto. */
export function feedAlertCutoff(now: Date): Date {
  return new Date(now.getTime() - FEED_ALERT_AFTER_HOURS * 3_600_000);
}

/**
 * El código guardado en `lastError` (ical-sync.ts) en palabras del dueño, con
 * lo que suele arreglarlo. Lo que no se reconoce sale tal cual: mejor un
 * código raro que esconder el error.
 */
export function feedErrorText(error: string | null): string {
  if (!error) return 'no se ha podido leer';
  if (error === 'http_404' || error === 'http_410') return 'la plataforma dice que esa URL ya no existe; si regeneraste el enlace, pega el nuevo';
  if (error === 'http_401' || error === 'http_403') return 'la plataforma no deja leerlo; comprueba que la URL es la de exportación';
  if (/^http_5\d\d$/.test(error)) return 'la plataforma no responde bien ahora mismo';
  if (/^http_\d+$/.test(error)) return `la plataforma ha contestado con un error (${error.slice(5)})`;
  if (error === 'not_ical') return 'esa URL no devuelve un calendario; comprueba que es la de exportación (.ics)';
  if (error === 'timeout') return 'la plataforma tarda demasiado en contestar';
  if (error === 'network_error') return 'no se ha podido conectar con la plataforma';
  if (error.startsWith('url_not_allowed')) return 'esa dirección no está permitida; usa la URL pública de la plataforma';
  return `no se ha podido leer (${error})`;
}
