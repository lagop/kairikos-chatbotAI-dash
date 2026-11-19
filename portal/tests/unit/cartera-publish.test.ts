// =============================================================================
// Cartera — la publicación desde el portal (PR 4): lanzar publicar.yml en
// GitHub, recibir sus avisos y lo que hace el cron. Con la base de datos falsa
// en memoria (tests/fixtures/cartera/fake-db.ts), `fetch` simulado y el envío
// de correo grabado: aquí no sale nada a la red.
//
// Al final, la prueba de cierre del brief: un cambio de precio en el panel
// lleva a un dispatch del cron con el cuerpo exacto del contrato, y los dos
// avisos con los cuerpos que monta publicar.yml (su `jq`) dejan la publicación
// en «ok».
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeCarteraDb, type FakeCarteraDb } from '../fixtures/cartera/fake-db';
import { fullVenta } from '../fixtures/cartera/full-homes';

const state = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  sent: [] as Array<{ to: string[]; subject: string; text: string }>,
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: new Proxy({}, { get: (_t, key) => state.db[key as string] }),
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ hasClientAccess: true }) }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => ({ source: 'database', clientId: 'client-1' }) }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/operator-alert-settings', () => ({ getOperatorAlertRecipients: async () => [{ email: 'avisos@kairikos.example' }] }));
// Se graba el envío en vez de simular Resend: dos `await import('resend')` a la
// vez (agencia y operador) dejan pasar el segundo al módulo real en vitest.
vi.mock('@/lib/cartera/emails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cartera/emails')>()),
  sendCarteraEmail: async (to: string | null | undefined, m: { subject: string; text: string }) => {
    if (!to) return { ok: true, skipped: true, reason: 'no_recipient' };
    state.sent.push({ to: [to], ...m });
    return { ok: true, messageId: `msg-${state.sent.length}` };
  },
}));

import { dispatchWorkflow, launchPublication, loadPublicationForPanel, markStaleBuilds, sweepCartera } from '@/lib/cartera/publish';
import { hashBuildSecret } from '@/lib/cartera/site';
import { createHome, saveHome } from '@/lib/cartera/homes';
import { NOTICES_PER_MINUTE } from '@/lib/cartera/public-http';
import { POST as noticePost } from '@/app/api/public/cartera/[token]/publicacion/route';
import { POST as publishPost } from '@/app/api/portal/cartera/publicar/route';
import { GET as cronGet } from '@/app/api/cron/cartera-tick/route';

const GH_TOKEN = 'ghp_token_de_prueba_no_real';
const SECRET = 'cbs_secreto_de_publicacion';
const ACTOR = 'client:client-1';
const MIN = 60_000;
const RUN = 'https://github.com/lagop/web-prueba/actions/runs/987654321';
const SHA = '0123456789abcdef0123456789abcdef01234567';

let f: FakeCarteraDb;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  f = fakeCarteraDb();
  state.db = f.db as never;
  state.sent.length = 0;
  process.env.CARTERA_GITHUB_TOKEN = GH_TOKEN;
  process.env.CRON_SECRET = 'cron-de-prueba';
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CARTERA_GITHUB_TOKEN;
  delete process.env.CRON_SECRET;
});

const asPrisma = () => f.db as never;

/** Un sitio con su secreto y `n` casas en venta, publicadas con las funciones del panel. */
async function siteWithHomes(n: number, over: Parameters<FakeCarteraDb['addSite']>[0] = {}) {
  const site = f.addSite({ buildSecretHash: hashBuildSecret(SECRET), ...over });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createHome(asPrisma(), site, 'venta', ACTOR);
    if (!c.ok) throw new Error('no se creó');
    const saved = await saveHome(asPrisma(), site, c.id, { status: 'venta', data: fullVenta() }, ACTOR);
    if (!saved.ok || saved.errors.length) throw new Error('no quedó publicable');
    ids.push(c.id);
  }
  return { site, ids };
}

const siteRow = (id: string) => f.sites.find((s) => s.id === id)!;

function notice(token: string, body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return noticePost(new NextRequest(`http://localhost/api/public/cartera/${token}/publicacion`, { method: 'POST', headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ token }),
  });
}

function publishNow(body?: unknown) {
  return publishPost(
    new NextRequest('http://localhost/api/portal/cartera/publicar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Los cuerpos que monta publicar.yml con jq (ver su paso «Avisar al portal»). */
const startBody = (buildId: string | null) => ({ buildId, status: 'en_curso', runUrl: RUN, commit: SHA });
const resultBody = (buildId: string | null, status: 'ok' | 'fallida', stage: 'construir' | 'subir' | null = null) => ({
  buildId,
  status,
  stage,
  release: status === 'ok' ? '20261120T120300Z-r987654321' : null,
  runUrl: RUN,
  commit: SHA,
});

// --- El dispatch ------------------------------------------------------------------

describe('el dispatch a GitHub', () => {
  it('llama al endpoint del contrato con el cuerpo exacto', async () => {
    const r = await dispatchWorkflow({ repo: 'lagop/web-prueba', workflowFile: 'publicar.yml', buildId: 'b-1', token: GH_TOKEN });
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/lagop/web-prueba/actions/workflows/publicar.yml/dispatches');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' });
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { publicacion: 'b-1' } });
  });

  it('un no-204 o un fallo de red se devuelven como error, sin lanzar', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message":"Bad credentials"}', { status: 401 }));
    expect(await dispatchWorkflow({ repo: 'a/b', workflowFile: 'publicar.yml', buildId: 'x', token: 't' })).toEqual({ ok: false, error: 'github_401:{"message":"Bad credentials"}' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await dispatchWorkflow({ repo: 'a/b', workflowFile: 'publicar.yml', buildId: 'x', token: 't' })).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});

// --- Lanzar ---------------------------------------------------------------------------

describe('lanzar', () => {
  it('el cron lanza lo pendiente: fila «enviada», cuántas casas lleva y auditoría', async () => {
    const { site } = await siteWithHomes(2);
    expect(siteRow(site.id).pendingSince).toBeInstanceOf(Date);

    const r = await sweepCartera(asPrisma(), new Date(Date.now() + MIN));
    expect(r).toEqual({ stale: 0, launched: 1, held: 0, failed: 0, skipped: 0 });
    expect(f.builds).toHaveLength(1);
    expect(f.builds[0]).toMatchObject({ siteId: site.id, trigger: 'cambio', status: 'enviada', homeCount: 2 });
    expect(siteRow(site.id).lastDispatchAt).toEqual(f.builds[0].dispatchedAt);
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_launched', entity: 'build', entityId: f.builds[0].id, actor: 'system', metadata: { trigger: 'cambio', homeCount: 2 } });

    // Otra pasada: hay una en curso, no lanza otra.
    expect(await sweepCartera(asPrisma(), new Date(Date.now() + 2 * MIN))).toMatchObject({ launched: 0, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('nada pendiente, sin token o sin repositorio: no llama a GitHub', async () => {
    const { site } = await siteWithHomes(1);
    delete process.env.CARTERA_GITHUB_TOKEN;
    expect(await launchPublication(asPrisma(), site.id, { mode: 'manual', actor: ACTOR })).toMatchObject({ ok: false, error: 'not_configured' });
    process.env.CARTERA_GITHUB_TOKEN = '   ';
    expect(await launchPublication(asPrisma(), site.id, { mode: 'manual', actor: ACTOR })).toMatchObject({ ok: false, error: 'not_configured' });
    process.env.CARTERA_GITHUB_TOKEN = GH_TOKEN;

    const bare = f.addSite({ id: crypto.randomUUID(), clientId: 'client-2', githubRepo: null });
    bare.pendingSince = new Date();
    expect(await launchPublication(asPrisma(), bare.id, { mode: 'manual', actor: ACTOR })).toMatchObject({ ok: false, error: 'not_configured' });

    siteRow(site.id).pendingSince = null;
    expect(await launchPublication(asPrisma(), site.id, { mode: 'manual', actor: ACTOR })).toMatchObject({ ok: false, error: 'nothing_pending' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.builds).toHaveLength(0);
  });

  it('«Publicar ahora» se salta los 15 minutos pero no una en curso', async () => {
    const { site } = await siteWithHomes(1);
    const first = await publishNow();
    expect(first.status).toBe(202);
    const { buildId } = await first.json();
    expect(f.builds[0]).toMatchObject({ id: buildId, trigger: 'manual' });

    // En curso: 409 aunque haya cambios.
    siteRow(site.id).pendingSince = new Date();
    const busy = await publishNow();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: 'in_progress' });

    // Acabada hace un minuto: el cron espera, «Publicar ahora» no.
    Object.assign(f.builds[0], { status: 'ok', finishedAt: new Date() });
    expect(await sweepCartera(asPrisma())).toMatchObject({ launched: 0, skipped: 1 });
    expect((await publishNow()).status).toBe(202);
    expect(f.builds.map((b) => b.trigger)).toEqual(['manual', 'manual']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('salvaguarda: el cron no retira casas de golpe; el panel pregunta y lanza al confirmar', async () => {
    const { site } = await siteWithHomes(1, { lastPublishedCount: 10 });

    expect(await sweepCartera(asPrisma(), new Date(Date.now() + MIN))).toMatchObject({ launched: 0, held: 1 });
    const panel = await loadPublicationForPanel(asPrisma(), siteRow(site.id) as never, 'active');
    expect(panel).toMatchObject({ homeCount: 1, lastPublishedCount: 10, removing: 9 });

    const ask = await publishNow();
    expect(ask.status).toBe(409);
    expect(await ask.json()).toMatchObject({ error: 'confirm_removal', removing: 9, homeCount: 1 });
    expect(fetchMock).not.toHaveBeenCalled();

    const go = await publishNow({ confirm: true });
    expect(go.status).toBe(202);
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_launched', metadata: { confirmedRemoval: true, homeCount: 1, lastPublishedCount: 10 } });
    expect((await publishNow({ confirm: true, extra: 1 })).status).toBe(400);
  });

  it('si GitHub no lo acepta: «fallida», correo a la agencia y a Kairikos, sin el token en ningún sitio', async () => {
    const { site } = await siteWithHomes(1);
    fetchMock.mockImplementation(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));

    const res = await publishNow();
    expect(res.status).toBe(502);
    expect(f.builds[0]).toMatchObject({ status: 'fallida', error: 'No se pudo lanzar en GitHub (github_401).' });
    expect(f.builds[0].finishedAt).toBeInstanceOf(Date);
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_dispatch_failed', metadata: { code: 'github_401' } });
    expect(state.sent.map((m) => m.to[0]).sort()).toEqual(['agencia@example.com', 'avisos@kairikos.example']);

    // El siguiente fallo de la racha no repite los correos.
    siteRow(site.id).pendingSince = new Date();
    await publishNow();
    expect(f.builds).toHaveLength(2);
    expect(state.sent).toHaveLength(2);

    const everything = JSON.stringify({ builds: f.builds, audits: f.audits, sent: state.sent });
    expect(everything).not.toContain(GH_TOKEN);
    expect(everything).not.toContain(SECRET);
  });
});

// --- Los avisos de publicar.yml -------------------------------------------------------

describe('la ruta de avisos', () => {
  async function launched() {
    const { site } = await siteWithHomes(3);
    const r = await launchPublication(asPrisma(), site.id, { mode: 'manual', actor: ACTOR });
    if (!r.ok) throw new Error(`no se lanzó: ${r.error}`);
    return { site: siteRow(site.id), token: String(siteRow(site.id).feedToken), buildId: r.buildId };
  }

  it('secreto incorrecto o ausente: 401; token desconocido: 404; cuerpo inválido: 400', async () => {
    const { token, buildId } = await launched();
    expect((await notice(token, startBody(buildId), 'cbs_otro')).status).toBe(401);
    expect((await notice(token, startBody(buildId), null)).status).toBe(401);
    expect((await notice('car_noexiste000000000000000', startBody(buildId))).status).toBe(404);
    expect((await notice(token, { ...startBody(buildId), status: 'ok_casi' })).status).toBe(400);
    expect((await notice(token, { ...startBody(buildId), runUrl: 'http://github.com/x' })).status).toBe(400);
    expect(f.builds[0].status).toBe('enviada');
  });

  it('un buildId de otro sitio da 404 y no toca nada', async () => {
    const { buildId } = await launched();
    const other = f.addSite({ clientId: 'client-2', buildSecretHash: hashBuildSecret('cbs_del_otro') });
    const res = await notice(String(other.feedToken), resultBody(buildId, 'ok'), 'cbs_del_otro');
    expect(res.status).toBe(404);
    expect(f.builds[0].status).toBe('enviada');
    expect((await notice(String(other.feedToken), resultBody('no-es-un-uuid', 'ok'), 'cbs_del_otro')).status).toBe(404);
  });

  it('en_curso → ok: la cuenta de casas queda como la publicada y el pendiente se limpia', async () => {
    const { site, token, buildId } = await launched();
    const start = await notice(token, startBody(buildId));
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ ok: true, status: 'en_curso' });
    expect(f.builds[0]).toMatchObject({ status: 'en_curso', runUrl: RUN, commitSha: SHA });

    const done = await notice(token, resultBody(buildId, 'ok'));
    expect(await done.json()).toEqual({ ok: true, status: 'ok' });
    expect(f.builds[0]).toMatchObject({ status: 'ok', release: '20261120T120300Z-r987654321', error: null, stage: null });
    expect(site.lastPublishedCount).toBe(3);
    expect(site.pendingSince).toBeNull();
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_finished', metadata: { status: 'ok', homeCount: 3 } });
    expect(state.sent).toHaveLength(0);

    // curl reintenta: el mismo aviso otra vez no cambia nada ni audita de nuevo.
    const audits = f.audits.length;
    expect((await notice(token, resultBody(buildId, 'ok'))).status).toBe(200);
    expect(f.audits).toHaveLength(audits);
  });

  it('un cambio después de lanzar deja el pendiente para la siguiente', async () => {
    const { site, token, buildId } = await launched();
    const later = new Date(Date.now() + MIN);
    site.lastChangeAt = later;
    await notice(token, resultBody(buildId, 'ok'));
    expect(site.pendingSince).toBeInstanceOf(Date);
    expect(site.lastPublishedCount).toBe(3);
  });

  it('en_curso → fallida: error legible con la fase y un correo a cada uno, solo al primero de la racha', async () => {
    const { site, token, buildId } = await launched();
    await notice(token, startBody(buildId));
    const res = await notice(token, resultBody(buildId, 'fallida', 'construir'));
    expect(await res.json()).toEqual({ ok: true, status: 'fallida' });
    expect(f.builds[0]).toMatchObject({ status: 'fallida', stage: 'construir' });
    expect(String(f.builds[0].error)).toMatch(/feed/);
    expect(site.pendingSince).toBeInstanceOf(Date);
    expect(site.lastPublishedCount).toBeNull();
    expect(state.sent.map((m) => m.to[0]).sort()).toEqual(['agencia@example.com', 'avisos@kairikos.example']);
    const operatorMail = state.sent.find((m) => m.to[0] === 'avisos@kairikos.example')!;
    expect(operatorMail.text).toContain(RUN);
    expect(state.sent.find((m) => m.to[0] === 'agencia@example.com')!.text).not.toContain('github.com');

    // Repetido: ni más correos ni otra auditoría.
    await notice(token, resultBody(buildId, 'fallida', 'construir'));
    expect(state.sent).toHaveLength(2);

    // La siguiente también falla: tampoco.
    Object.assign(site, { lastDispatchAt: new Date(Date.now() - 2 * 60 * MIN) });
    const again = await launchPublication(asPrisma(), site.id, { mode: 'manual', actor: ACTOR });
    if (!again.ok) throw new Error('no se lanzó');
    await notice(token, resultBody(again.buildId, 'fallida', 'subir'));
    expect(state.sent).toHaveLength(2);
  });

  it('buildId nulo: una publicación «externa», que el resultado empareja por runUrl', async () => {
    const { site, token } = await launched();
    f.builds[0].status = 'ok';
    const start = await notice(token, startBody(null));
    expect(start.status).toBe(200);
    expect(f.builds).toHaveLength(2);
    expect(f.builds[1]).toMatchObject({ trigger: 'externa', status: 'en_curso', runUrl: RUN, homeCount: 3 });
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_external' });

    await notice(token, resultBody(null, 'ok'));
    expect(f.builds).toHaveLength(2);
    expect(f.builds[1]).toMatchObject({ status: 'ok' });
    expect(site.lastPublishedCount).toBe(3);
    // Empezó después del último cambio: lo que había pendiente ya está en la web.
    expect(site.pendingSince).toBeNull();
    site.pendingSince = new Date();

    // Una externa conocida solo por su resultado: se apunta, pero no da por publicado lo pendiente.
    const onlyResult = { ...resultBody(null, 'ok'), runUrl: `${RUN}0` };
    await notice(token, onlyResult);
    expect(f.builds).toHaveLength(3);
    expect(f.builds[2]).toMatchObject({ trigger: 'externa', status: 'ok' });
    expect(site.pendingSince).toBeInstanceOf(Date);
  });

  it('limita los avisos por token', async () => {
    const token = `car_limite${crypto.randomUUID().replace(/-/g, '')}`;
    for (let i = 0; i < NOTICES_PER_MINUTE; i++) expect((await notice(token, startBody(null))).status).toBe(404);
    expect((await notice(token, startBody(null))).status).toBe(429);
  });
});

// --- Desconocida ------------------------------------------------------------------------

describe('sin noticias en 45 minutos', () => {
  it('pasa a «desconocida», sin correos; una con un aviso reciente sigue en curso', async () => {
    const { site } = await siteWithHomes(1);
    const old = new Date(Date.now() - 46 * MIN);
    f.builds.push(
      { id: crypto.randomUUID(), siteId: site.id, trigger: 'cambio', status: 'enviada', homeCount: 1, dispatchedAt: old, lastNoticeAt: null, finishedAt: null },
      { id: crypto.randomUUID(), siteId: site.id, trigger: 'cambio', status: 'en_curso', homeCount: 1, dispatchedAt: old, lastNoticeAt: new Date(Date.now() - 10 * MIN), finishedAt: null },
    );
    expect(await markStaleBuilds(asPrisma())).toBe(1);
    expect(f.builds[0]).toMatchObject({ status: 'desconocida' });
    expect(String(f.builds[0].error)).toMatch(/45 minutos/);
    expect(f.builds[1].status).toBe('en_curso');
    expect(f.audits.at(-1)).toMatchObject({ action: 'publish_unknown', metadata: { was: 'enviada' } });
    expect(state.sent).toHaveLength(0);
    expect(await markStaleBuilds(asPrisma())).toBe(0);

    // Un resultado tardío la corrige.
    const token = String(siteRow(site.id).feedToken);
    await notice(token, resultBody(String(f.builds[0].id), 'ok'));
    expect(f.builds[0].status).toBe('ok');
  });
});

describe('el cron', () => {
  it('pide el CRON_SECRET', async () => {
    expect((await cronGet(new NextRequest('http://localhost/api/cron/cartera-tick'))).status).toBe(401);
    const ok = await cronGet(new NextRequest('http://localhost/api/cron/cartera-tick', { headers: { authorization: 'Bearer cron-de-prueba' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stale: 0, launched: 0, held: 0, failed: 0, skipped: 0 });
  });
});

// --- Prueba de cierre -------------------------------------------------------------------

describe('prueba de cierre: del cambio de precio a la web publicada', () => {
  it('un cambio de precio en el panel → dispatch del cron con el cuerpo del contrato → avisos de publicar.yml → ok', async () => {
    // Una casa publicada y ya en la web.
    const { site, ids } = await siteWithHomes(1);
    const token = String(siteRow(site.id).feedToken);
    await sweepCartera(asPrisma());
    const first = String(f.builds[0].id);
    await notice(token, startBody(first));
    await notice(token, resultBody(first, 'ok'));
    expect(siteRow(site.id).pendingSince).toBeNull();
    fetchMock.mockClear();

    // La agencia baja el precio en el panel.
    const saved = await saveHome(asPrisma(), site, ids[0], { data: { ...fullVenta(), price: 799000 } }, ACTOR);
    expect(saved).toMatchObject({ ok: true, errors: [] });
    expect(siteRow(site.id).pendingSince).toBeInstanceOf(Date);

    // El cron, antes de 15 minutos, espera; pasados, lanza.
    expect(await sweepCartera(asPrisma(), new Date(Date.now() + 5 * MIN))).toMatchObject({ launched: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sweepCartera(asPrisma(), new Date(Date.now() + 16 * MIN))).toMatchObject({ launched: 1 });
    const build = f.builds[1];
    expect(build).toMatchObject({ trigger: 'cambio', status: 'enviada', homeCount: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/lagop/web-prueba/actions/workflows/publicar.yml/dispatches');
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main', inputs: { publicacion: build.id } });

    // publicar.yml avisa al empezar y al acabar, con los cuerpos de su jq.
    expect((await notice(token, { buildId: build.id, status: 'en_curso', runUrl: RUN, commit: SHA })).status).toBe(200);
    const done = await notice(token, { buildId: build.id, status: 'ok', stage: null, release: '20261120T121500Z-r987654321', runUrl: RUN, commit: SHA });
    expect(await done.json()).toEqual({ ok: true, status: 'ok' });

    expect(build).toMatchObject({ status: 'ok', runUrl: RUN, commitSha: SHA, release: '20261120T121500Z-r987654321' });
    expect(siteRow(site.id)).toMatchObject({ pendingSince: null, lastPublishedCount: 1 });
    const panel = await loadPublicationForPanel(asPrisma(), siteRow(site.id) as never, 'active');
    expect(panel.builds[0]).toMatchObject({ id: build.id, status: 'ok', trigger: 'cambio', runUrl: RUN });
    expect(panel).toMatchObject({ pendingSince: null, removing: null, homeCount: 1 });
  });
});
