// =============================================================================
// Cartera — las reglas de la publicación (lib/cartera/publish-rules.ts):
// cuándo se lanza, la salvaguarda de vaciado, qué hace cada aviso de GitHub y
// cuándo una publicación pasa a «desconocida». Puras.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { applyNotice, decideLaunch, isStale, removalGuard, stillPendingAfterOk, type LaunchInput } from '@/lib/cartera/publish-rules';

const NOW = new Date('2026-11-20T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    mode: 'auto',
    configured: true,
    active: true,
    pendingSince: ago(2),
    lastChangeAt: ago(2),
    lastDispatchAt: ago(60),
    inProgress: false,
    lastBuild: { status: 'ok', dispatchedAt: ago(60) },
    homeCount: 20,
    lastPublishedCount: 20,
    now: NOW,
    ...over,
  };
}

describe('cuándo se lanza', () => {
  it('con algo pendiente, nada en curso y la última hace más de 15 minutos', () => {
    expect(decideLaunch(input())).toEqual({ launch: true, trigger: 'cambio' });
    expect(decideLaunch(input({ lastDispatchAt: null, lastBuild: null }))).toEqual({ launch: true, trigger: 'cambio' });
  });

  it('sin nada pendiente, no', () => {
    expect(decideLaunch(input({ pendingSince: null }))).toEqual({ launch: false, reason: 'nothing_pending' });
    expect(decideLaunch(input({ mode: 'manual', pendingSince: null }))).toEqual({ launch: false, reason: 'nothing_pending' });
  });

  it('con una en curso, no; tampoco «Publicar ahora»', () => {
    expect(decideLaunch(input({ inProgress: true }))).toEqual({ launch: false, reason: 'in_progress' });
    expect(decideLaunch(input({ mode: 'manual', inProgress: true }))).toEqual({ launch: false, reason: 'in_progress' });
  });

  it('15 minutos entre una y otra, salvo «Publicar ahora»', () => {
    expect(decideLaunch(input({ lastDispatchAt: ago(14) }))).toEqual({ launch: false, reason: 'too_soon' });
    expect(decideLaunch(input({ lastDispatchAt: ago(15) }))).toEqual({ launch: true, trigger: 'cambio' });
    expect(decideLaunch(input({ mode: 'manual', lastDispatchAt: ago(1) }))).toEqual({ launch: true, trigger: 'manual' });
  });

  it('sin repositorio o token, o con la contratación no activa, no', () => {
    expect(decideLaunch(input({ configured: false }))).toEqual({ launch: false, reason: 'not_configured' });
    expect(decideLaunch(input({ active: false, mode: 'manual' }))).toEqual({ launch: false, reason: 'not_active' });
  });

  it('tras un fallo, el cron espera una hora salvo que haya un cambio nuevo', () => {
    const failed = { status: 'fallida', dispatchedAt: ago(20) };
    expect(decideLaunch(input({ lastDispatchAt: ago(20), lastBuild: failed, lastChangeAt: ago(30) }))).toEqual({ launch: false, reason: 'retry_later' });
    expect(decideLaunch(input({ lastDispatchAt: ago(20), lastBuild: failed, lastChangeAt: ago(5) }))).toEqual({ launch: true, trigger: 'cambio' });
    expect(decideLaunch(input({ lastDispatchAt: ago(61), lastBuild: { status: 'desconocida', dispatchedAt: ago(61) }, lastChangeAt: ago(90) }))).toEqual({ launch: true, trigger: 'cambio' });
    // «Publicar ahora» no espera.
    expect(decideLaunch(input({ mode: 'manual', lastDispatchAt: ago(20), lastBuild: failed, lastChangeAt: ago(30) }))).toEqual({ launch: true, trigger: 'manual' });
  });
});

describe('salvaguarda de vaciado', () => {
  it('menos del 70 % de la última correcta y más de 3 que faltan', () => {
    expect(removalGuard(13, 20)).toEqual({ hold: true, removing: 7 });
    expect(removalGuard(14, 20)).toEqual({ hold: false, removing: 6 });
    // El 70 % pero solo faltan 3: sale sola (una cartera pequeña vende casas).
    expect(removalGuard(2, 5)).toEqual({ hold: false, removing: 3 });
    expect(removalGuard(0, 4)).toEqual({ hold: true, removing: 4 });
    expect(removalGuard(25, 20)).toEqual({ hold: false, removing: 0 });
    expect(removalGuard(0, null)).toEqual({ hold: false, removing: 0 });
  });

  it('no se lanza sola; «Publicar ahora» pregunta y lanza al confirmar', () => {
    const emptied = { homeCount: 0, lastPublishedCount: 12 };
    expect(decideLaunch(input(emptied))).toEqual({ launch: false, reason: 'confirm_removal', removing: 12 });
    expect(decideLaunch(input({ ...emptied, mode: 'manual' }))).toEqual({ launch: false, reason: 'confirm_removal', removing: 12 });
    expect(decideLaunch(input({ ...emptied, mode: 'manual', confirmRemoval: true }))).toEqual({ launch: true, trigger: 'manual' });
    // Confirmar no vale para el cron.
    expect(decideLaunch(input({ ...emptied, confirmRemoval: true }))).toEqual({ launch: false, reason: 'confirm_removal', removing: 12 });
  });
});

describe('los avisos de GitHub', () => {
  const RUN = 'https://github.com/lagop/web-prueba/actions/runs/1234';
  const sent = { status: 'enviada', runUrl: null, finishedAt: null };

  it('en_curso apunta el enlace de la ejecución', () => {
    const e = applyNotice(sent, { buildId: 'b', status: 'en_curso', runUrl: RUN, commit: 'abc1234' }, NOW);
    expect(e).toEqual({ status: 'en_curso', data: { status: 'en_curso', runUrl: RUN, lastNoticeAt: NOW, commitSha: 'abc1234' }, finished: null });
  });

  it('ok y fallida acaban la publicación, con la fase y un error legible', () => {
    const ok = applyNotice({ ...sent, status: 'en_curso' }, { buildId: 'b', status: 'ok', stage: null, release: '20261120T120300Z-r1234', runUrl: RUN, commit: 'abc1234' }, NOW);
    expect(ok.finished).toBe('ok');
    expect(ok.data).toMatchObject({ status: 'ok', finishedAt: NOW, release: '20261120T120300Z-r1234', error: null, stage: null });

    const failed = applyNotice({ ...sent, status: 'en_curso' }, { buildId: 'b', status: 'fallida', stage: 'construir', release: null, runUrl: RUN }, NOW);
    expect(failed.finished).toBe('fallida');
    expect(failed.data).toMatchObject({ status: 'fallida', stage: 'construir' });
    expect(failed.data.error).toMatch(/feed/);
  });

  it('un aviso repetido (curl reintenta) no vuelve a «acabar» la publicación', () => {
    const done = { status: 'fallida', runUrl: RUN, finishedAt: ago(1) };
    const again = applyNotice(done, { buildId: 'b', status: 'fallida', stage: 'subir', runUrl: RUN }, NOW);
    expect(again.finished).toBeNull();
    expect(again.data.finishedAt).toEqual(ago(1));
  });

  it('un en_curso tardío no devuelve a «en curso» una que ya acabó', () => {
    expect(applyNotice({ status: 'ok', runUrl: RUN, finishedAt: ago(1) }, { buildId: 'b', status: 'en_curso', runUrl: RUN }, NOW).status).toBe('ok');
  });

  it('un resultado tardío corrige una «desconocida»', () => {
    const late = applyNotice({ status: 'desconocida', runUrl: null, finishedAt: ago(5) }, { buildId: 'b', status: 'ok', runUrl: RUN }, NOW);
    expect(late).toMatchObject({ status: 'ok', finished: 'ok' });
  });
});

describe('sin noticias en 45 minutos', () => {
  it('cuenta desde el último aviso, o desde el lanzamiento si no hubo', () => {
    expect(isStale({ status: 'enviada', dispatchedAt: ago(45), lastNoticeAt: null }, NOW)).toBe(true);
    expect(isStale({ status: 'enviada', dispatchedAt: ago(44), lastNoticeAt: null }, NOW)).toBe(false);
    expect(isStale({ status: 'en_curso', dispatchedAt: ago(70), lastNoticeAt: ago(30) }, NOW)).toBe(false);
    expect(isStale({ status: 'ok', dispatchedAt: ago(300), lastNoticeAt: null }, NOW)).toBe(false);
  });
});

describe('tras una correcta', () => {
  it('solo quedan cambios si los hubo después de lanzarla', () => {
    expect(stillPendingAfterOk(ago(10), ago(5))).toBe(false);
    expect(stillPendingAfterOk(ago(1), ago(5))).toBe(true);
    expect(stillPendingAfterOk(null, ago(5))).toBe(false);
  });
});
