// =============================================================================
// Reserva propia para villas — el resumen de una villa plegada.
//
// En la pestaña «Villas» cada villa enseñaba todo abierto (precios, temporadas,
// calendarios, cierres): con dos o tres volvía el scroll que las pestañas
// habían quitado. Ahora se pliegan, y la cabecera tiene que decir lo bastante
// para no tener que abrirlas: el precio, y sobre todo si la sincronización con
// Airbnb/Booking va bien, que es lo único de aquí dentro que puede romperse
// solo y acabar en una doble reserva.
//
// Sin 'server-only': lo usa el componente de cliente y se testea sin DOM.
// =============================================================================

export interface FeedForSummary {
  label: string;
  /** 'ok' | 'error' | null (sin leer todavía) — ver VillaIcalFeed.lastStatus. */
  lastStatus: string | null;
}

export interface SyncSummary {
  tone: 'ok' | 'danger' | 'muted';
  text: string;
}

/**
 * Una línea sobre los calendarios importados de una villa. El orden importa:
 * un solo error manda sobre todo lo demás, porque es lo que pide actuar.
 */
export function villaSyncSummary(feeds: readonly FeedForSummary[]): SyncSummary {
  if (feeds.length === 0) return { tone: 'muted', text: 'Sin calendarios conectados' };
  const failing = feeds.filter((f) => f.lastStatus === 'error');
  if (failing.length > 0) {
    return { tone: 'danger', text: `Error al leer ${failing.map((f) => f.label).join(', ')}` };
  }
  if (feeds.some((f) => f.lastStatus !== 'ok')) return { tone: 'muted', text: 'Calendarios sin leer todavía' };
  return { tone: 'ok', text: feeds.length === 1 ? '1 calendario al día' : `${feeds.length} calendarios al día` };
}

/**
 * Con una sola villa no hay nada que plegar: se abre. Con varias empiezan
 * cerradas, salvo la que tiene un calendario fallando, que es a la que hay
 * que entrar.
 */
export function villaStartsOpen(villaCount: number, feeds: readonly FeedForSummary[]): boolean {
  return villaCount <= 1 || feeds.some((f) => f.lastStatus === 'error');
}
