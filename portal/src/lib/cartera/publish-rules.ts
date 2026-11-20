// =============================================================================
// Cartera — las reglas de la publicación (PR 4; docs/fase1-cartera.md,
// «Publicar sin que nadie lo lance (M0)»). Puras, sin base de datos ni red:
// las usan lib/cartera/publish.ts, el panel y sus tests.
//
//   - Se lanza si hay algo pendiente (pendingSince), no hay ninguna en curso
//     y la última salió hace más de 15 minutos. «Publicar ahora» se salta los
//     15 minutos, nunca lo de «ninguna en curso».
//   - Salvaguarda de vaciado: si la publicación va a llevar menos del 70 % de
//     las casas de la última correcta y faltan más de 3, no se lanza sola; el
//     panel pide confirmación.
//   - Tras una fallida o desconocida, el cron no relanza lo mismo cada 15
//     minutos: espera una hora, salvo que haya un cambio nuevo. Un feed roto
//     fallaría igual cada vez y mandaría un correo cada vez.
//   - Una publicación sin noticias en 45 minutos pasa a «desconocida».
// =============================================================================

export const AUTO_INTERVAL_MS = 15 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
export const UNKNOWN_AFTER_MS = 45 * 60_000;
export const SAFEGUARD_RATIO = 0.7;
export const SAFEGUARD_MIN_MISSING = 3;

export const BUILD_STATUSES = ['enviada', 'en_curso', 'ok', 'fallida', 'desconocida'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
/** Las que cuentan como «en curso»: lanzada y todavía sin resultado. */
export const ACTIVE_BUILD_STATUSES: readonly BuildStatus[] = ['enviada', 'en_curso'];
export type BuildTrigger = 'cambio' | 'manual' | 'externa';

export const BUILD_STATUS_LABELS: Record<string, string> = {
  enviada: 'Lanzada',
  en_curso: 'En curso',
  ok: 'Correcta',
  fallida: 'Fallida',
  desconocida: 'Sin noticias',
};
export const BUILD_TRIGGER_LABELS: Record<string, string> = {
  cambio: 'Automática',
  manual: 'Publicar ahora',
  externa: 'Fuera del portal',
};

export function isActiveBuild(status: string): boolean {
  return (ACTIVE_BUILD_STATUSES as readonly string[]).includes(status);
}

// --- Salvaguarda de vaciado ------------------------------------------------------

export interface RemovalCheck {
  /** true: no se lanza sola, hay que confirmarlo en el panel. */
  hold: boolean;
  /** Casas que dejarían de estar en la web respecto a la última correcta. */
  removing: number;
}

export function removalGuard(homeCount: number, lastPublishedCount: number | null): RemovalCheck {
  if (lastPublishedCount === null || lastPublishedCount <= 0) return { hold: false, removing: 0 };
  const removing = Math.max(0, lastPublishedCount - homeCount);
  return { hold: homeCount < lastPublishedCount * SAFEGUARD_RATIO && removing > SAFEGUARD_MIN_MISSING, removing };
}

// --- ¿Se lanza? --------------------------------------------------------------------

export interface LaunchInput {
  mode: 'auto' | 'manual';
  /** Solo «Publicar ahora», tras el «¿Publicar?» del panel. */
  confirmRemoval?: boolean;
  /** Repositorio y token de GitHub puestos. */
  configured: boolean;
  /** La contratación está activa (pausada o de baja, el feed no responde). */
  active: boolean;
  pendingSince: Date | null;
  lastChangeAt: Date | null;
  lastDispatchAt: Date | null;
  /** Hay una lanzada o en curso. */
  inProgress: boolean;
  /** La última publicación de cualquier origen, para la espera tras un fallo. */
  lastBuild: { status: string; dispatchedAt: Date } | null;
  homeCount: number;
  lastPublishedCount: number | null;
  now: Date;
}

export type LaunchDecision =
  | { launch: true; trigger: BuildTrigger }
  | { launch: false; reason: 'not_configured' | 'not_active' | 'in_progress' | 'nothing_pending' | 'too_soon' | 'retry_later' }
  | { launch: false; reason: 'confirm_removal'; removing: number };

export function decideLaunch(input: LaunchInput): LaunchDecision {
  if (!input.configured) return { launch: false, reason: 'not_configured' };
  if (!input.active) return { launch: false, reason: 'not_active' };
  if (input.inProgress) return { launch: false, reason: 'in_progress' };
  if (!input.pendingSince) return { launch: false, reason: 'nothing_pending' };

  const now = input.now.getTime();
  if (input.mode === 'auto') {
    if (input.lastDispatchAt && now - input.lastDispatchAt.getTime() < AUTO_INTERVAL_MS) return { launch: false, reason: 'too_soon' };
    const last = input.lastBuild;
    if (last && (last.status === 'fallida' || last.status === 'desconocida')) {
      const changedSince = input.lastChangeAt !== null && input.lastChangeAt.getTime() > last.dispatchedAt.getTime();
      if (!changedSince && now - last.dispatchedAt.getTime() < RETRY_AFTER_FAILURE_MS) return { launch: false, reason: 'retry_later' };
    }
  }

  const guard = removalGuard(input.homeCount, input.lastPublishedCount);
  if (guard.hold && !(input.mode === 'manual' && input.confirmRemoval)) return { launch: false, reason: 'confirm_removal', removing: guard.removing };

  return { launch: true, trigger: input.mode === 'auto' ? 'cambio' : 'manual' };
}

// --- El aviso de GitHub ------------------------------------------------------------

/** El cuerpo que manda publicar.yml (docs/publicacion.md, «Contrato con el portal»). */
export interface BuildNotice {
  buildId: string | null;
  status: 'en_curso' | 'ok' | 'fallida';
  stage?: 'construir' | 'subir' | null;
  release?: string | null;
  runUrl: string;
  commit?: string | null;
}

export interface BuildBefore {
  status: string;
  runUrl: string | null;
  finishedAt: Date | null;
}

export interface NoticeEffect {
  status: string;
  /** Campos que cambian en la fila. */
  data: { status: string; runUrl: string; lastNoticeAt: Date; finishedAt?: Date | null; stage?: string | null; release?: string | null; commitSha?: string | null; error?: string | null };
  /** Pasa a ok/fallida AHORA (no un aviso repetido): toca el sitio, audita y avisa. */
  finished: 'ok' | 'fallida' | null;
}

export const STAGE_ERRORS: Record<string, string> = {
  construir: 'Falló al construir la web: suele ser el feed (caído o con una casa que no valida) o una foto de un dominio no autorizado.',
  subir: 'La web se construyó, pero no se pudo subir al servidor.',
};

/**
 * Lo que hace un aviso con la publicación. Idempotente: curl lo reintenta, y
 * un aviso repetido no vuelve a mandar correos. Un `en_curso` tardío nunca
 * devuelve a «en curso» una que ya acabó; un resultado tardío sí corrige una
 * «desconocida» (lo que diga GitHub es lo que está en la web).
 */
export function applyNotice(before: BuildBefore, notice: BuildNotice, now: Date): NoticeEffect {
  const base = { runUrl: notice.runUrl, lastNoticeAt: now, ...(notice.commit ? { commitSha: notice.commit } : {}) };
  if (notice.status === 'en_curso') {
    const status = before.status === 'enviada' || before.status === 'desconocida' ? 'en_curso' : before.status;
    return { status, data: { ...base, status }, finished: null };
  }
  const repeated = before.status === notice.status;
  const stage = notice.status === 'fallida' ? (notice.stage ?? null) : null;
  return {
    status: notice.status,
    data: {
      ...base,
      status: notice.status,
      finishedAt: repeated && before.finishedAt ? before.finishedAt : now,
      stage,
      release: notice.release ?? null,
      error: notice.status === 'fallida' ? (stage ? STAGE_ERRORS[stage] : 'La publicación ha fallado.') : null,
    },
    finished: repeated ? null : notice.status,
  };
}

/** Sin noticias desde hace 45 minutos: ni lanzada ni en curso de verdad. */
export function isStale(build: { status: string; dispatchedAt: Date; lastNoticeAt: Date | null }, now: Date): boolean {
  if (!isActiveBuild(build.status)) return false;
  const last = Math.max(build.dispatchedAt.getTime(), build.lastNoticeAt?.getTime() ?? 0);
  return now.getTime() - last >= UNKNOWN_AFTER_MS;
}

/** Tras una correcta: ¿quedan cambios sin publicar? Solo si los hubo después de lanzarla. */
export function stillPendingAfterOk(lastChangeAt: Date | null, dispatchedAt: Date): boolean {
  return lastChangeAt !== null && lastChangeAt.getTime() > dispatchedAt.getTime();
}
