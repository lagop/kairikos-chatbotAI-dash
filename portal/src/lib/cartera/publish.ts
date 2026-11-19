import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { getOperatorAlertRecipients } from '@/lib/operator-alert-settings';
import { auditCartera, loadFeedRows, type Db } from './site';
import { buildFeed } from './feed';
import { ACTIVE_BUILD_STATUSES, applyNotice, decideLaunch, isStale, removalGuard, stillPendingAfterOk, UNKNOWN_AFTER_MS, type BuildNotice, type LaunchDecision } from './publish-rules';
import { renderAgencyFailedEmail, renderOperatorFailedEmail, sendCarteraEmail, type FailedBuildInfo } from './emails';
import { purgeOldEnquiries } from './enquiries';

// =============================================================================
// Cartera — publicar la web desde el portal (PR 4). Las reglas viven en
// publish-rules.ts; aquí la base de datos, la red y los correos.
//
// El contrato con la web es el de su docs/publicacion.md («Contrato con el
// portal»), y su .github/workflows/publicar.yml ya lo cumple en producción:
//
//   lanzar  POST https://api.github.com/repos/<githubRepo>/actions/workflows/<workflowFile>/dispatches
//           { "ref": "main", "inputs": { "publicacion": "<id de CarteraBuild>" } }
//           con CARTERA_GITHUB_TOKEN. GitHub responde 204 sin el id de la ejecución.
//   avisos  POST /api/public/cartera/<token>/publicacion, Bearer <secreto de publicación>:
//           `en_curso` al empezar (trae el runUrl) y el resultado.
//
// Lanzar va en dos pasos: primero la fila (con el sitio bloqueado, para que
// el cron y «Publicar ahora» no lancen dos a la vez) y después la llamada a
// GitHub, fuera de la transacción: no se tiene una transacción abierta
// esperando a la red. Si el proceso muere entre los dos, la fila queda
// «enviada» y a los 45 minutos pasa a «desconocida».
// =============================================================================

const GITHUB_API = 'https://api.github.com';

/** Token de grano fino, limitado a los repositorios de las webs Signature y con
 *  permiso de Actions. Vacío = sin configurar (trampa nº 4: vacía no es ausente). */
export function githubToken(): string | null {
  return process.env.CARTERA_GITHUB_TOKEN?.trim() || null;
}

/** Las casas que llevaría el feed ahora mismo: publicables y válidas para la web. */
export async function publishableCount(db: Db, siteId: string): Promise<number> {
  // La URL base solo hace falta para montar las de las fotos; para contar, da igual.
  const { feed } = buildFeed(await loadFeedRows(db, siteId), { baseUrl: 'https://portal.invalid' });
  return feed.ventas.length + feed.alquileres.length;
}

export type DispatchResult = { ok: true } | { ok: false; error: string };

/** Lanza publicar.yml. Nunca lanza una excepción. */
export async function dispatchWorkflow(input: { repo: string; workflowFile: string; buildId: string; token: string }): Promise<DispatchResult> {
  const url = `${GITHUB_API}/repos/${input.repo}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'kairikos-portal',
      },
      body: JSON.stringify({ ref: 'main', inputs: { publicacion: input.buildId } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204) return { ok: true };
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `github_${res.status}:${detail.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'dispatch_failed' };
  }
}

// --- Lanzar ------------------------------------------------------------------------

export type LaunchResult =
  | { ok: true; buildId: string; homeCount: number }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'dispatch_failed'; buildId: string }
  | { ok: false; error: Exclude<LaunchDecision, { launch: true }>['reason']; removing?: number; homeCount: number };

export async function launchPublication(
  prisma: PrismaClient,
  siteId: string,
  opts: { mode: 'auto' | 'manual'; confirmRemoval?: boolean; actor: string; now?: Date },
): Promise<LaunchResult> {
  const now = opts.now ?? new Date();
  const token = githubToken();

  const prep = await prisma.$transaction(async (tx) => {
    // Un lanzamiento a la vez por sitio: el cron y «Publicar ahora» pueden coincidir.
    await tx.$queryRaw`SELECT id FROM cartera_site WHERE id = ${siteId}::uuid FOR UPDATE`;
    const site = await tx.carteraSite.findUnique({ where: { id: siteId }, include: { clientProduct: { select: { status: true } } } });
    if (!site) return { kind: 'not_found' as const };
    const [inProgress, lastBuild, homeCount] = await Promise.all([
      tx.carteraBuild.findFirst({ where: { siteId, status: { in: [...ACTIVE_BUILD_STATUSES] } }, select: { id: true } }),
      tx.carteraBuild.findFirst({ where: { siteId }, orderBy: { dispatchedAt: 'desc' }, select: { status: true, dispatchedAt: true } }),
      publishableCount(tx, siteId),
    ]);
    const decision = decideLaunch({
      mode: opts.mode,
      confirmRemoval: opts.confirmRemoval,
      configured: Boolean(site.githubRepo && token),
      active: site.clientProduct.status === 'active',
      pendingSince: site.pendingSince,
      lastChangeAt: site.lastChangeAt,
      lastDispatchAt: site.lastDispatchAt,
      inProgress: inProgress !== null,
      lastBuild,
      homeCount,
      lastPublishedCount: site.lastPublishedCount,
      now,
    });
    if (!decision.launch) return { kind: 'skip' as const, decision, homeCount };

    const build = await tx.carteraBuild.create({ data: { siteId, trigger: decision.trigger, homeCount, dispatchedAt: now, status: 'enviada' }, select: { id: true } });
    await tx.carteraSite.update({ where: { id: siteId }, data: { lastDispatchAt: now } });
    await auditCartera(tx, {
      siteId,
      clientId: site.clientId,
      entity: 'build',
      entityId: build.id,
      action: 'publish_launched',
      actor: opts.actor,
      metadata: { trigger: decision.trigger, homeCount, lastPublishedCount: site.lastPublishedCount, confirmedRemoval: Boolean(opts.confirmRemoval) },
    });
    return { kind: 'launched' as const, buildId: build.id, homeCount, trigger: decision.trigger, site };
  });

  if (prep.kind === 'not_found') return { ok: false, error: 'not_found' };
  if (prep.kind === 'skip') {
    const d = prep.decision as Exclude<LaunchDecision, { launch: true }>;
    return { ok: false, error: d.reason, homeCount: prep.homeCount, ...('removing' in d ? { removing: d.removing } : {}) };
  }

  const dispatched = await dispatchWorkflow({ repo: prep.site.githubRepo!, workflowFile: prep.site.workflowFile, buildId: prep.buildId, token: token! });
  if (dispatched.ok) return { ok: true, buildId: prep.buildId, homeCount: prep.homeCount };

  // GitHub no la aceptó (token caducado, repositorio o flujo mal puestos): fallida
  // en el sitio, con el código de GitHub para quien lo mire; nunca el token.
  const error = `No se pudo lanzar en GitHub (${dispatched.error.split(':')[0]}).`;
  const notify = await prisma.$transaction(async (tx) => {
    await tx.carteraBuild.update({ where: { id: prep.buildId }, data: { status: 'fallida', finishedAt: new Date(), error } });
    await auditCartera(tx, {
      siteId,
      clientId: prep.site.clientId,
      entity: 'build',
      entityId: prep.buildId,
      action: 'publish_dispatch_failed',
      actor: 'system',
      metadata: { code: dispatched.error.split(':')[0] },
    });
    return isFirstFailureInARow(tx, siteId, prep.buildId);
  });
  if (notify) {
    await notifyFailure(prisma, {
      siteUrl: prep.site.siteUrl,
      githubRepo: prep.site.githubRepo,
      buildId: prep.buildId,
      trigger: prep.trigger,
      stage: null,
      error,
      runUrl: null,
      clientId: prep.site.clientId,
    });
  }
  return { ok: false, error: 'dispatch_failed', buildId: prep.buildId };
}

// --- Avisos de GitHub ----------------------------------------------------------------

export type NoticeResult = { ok: true; buildId: string; status: string } | { ok: false; error: 'build_not_found' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un aviso de publicar.yml. Busca la publicación por `buildId`; si no trae, por
 * `runUrl`; si tampoco, la crea como «externa» (a mano en GitHub o una subida a
 * main): es lo que está en la web, y su cuenta de casas es la base de la
 * salvaguarda de vaciado. Un `buildId` que no es de ESTE sitio no se encuentra.
 */
export async function recordNotice(
  prisma: PrismaClient,
  site: { id: string; clientId: string; siteUrl: string | null; githubRepo: string | null },
  notice: BuildNotice,
  now: Date = new Date(),
): Promise<NoticeResult> {
  const out = await prisma.$transaction(async (tx) => {
    let build = null as null | { id: string; status: string; runUrl: string | null; finishedAt: Date | null; dispatchedAt: Date; homeCount: number; trigger: string };
    const select = { id: true, status: true, runUrl: true, finishedAt: true, dispatchedAt: true, homeCount: true, trigger: true } as const;
    let created = false;
    if (notice.buildId) {
      if (!UUID_RE.test(notice.buildId)) return { ok: false as const, error: 'build_not_found' as const };
      build = await tx.carteraBuild.findFirst({ where: { id: notice.buildId.toLowerCase(), siteId: site.id }, select });
      if (!build) return { ok: false as const, error: 'build_not_found' as const };
    } else {
      build = await tx.carteraBuild.findFirst({ where: { siteId: site.id, runUrl: notice.runUrl }, orderBy: { dispatchedAt: 'desc' }, select });
      if (!build) {
        const homeCount = await publishableCount(tx, site.id);
        build = await tx.carteraBuild.create({ data: { siteId: site.id, trigger: 'externa', homeCount, dispatchedAt: now, status: 'enviada', runUrl: notice.runUrl }, select });
        created = true;
      }
    }

    const effect = applyNotice(build, notice, now);
    await tx.carteraBuild.update({ where: { id: build.id }, data: effect.data });

    if (effect.finished === 'ok') {
      const current = await tx.carteraSite.findUnique({ where: { id: site.id }, select: { lastChangeAt: true } });
      // Una externa que se conoce por su resultado no dice cuándo leyó el feed:
      // no se da nada por publicado, solo se apunta la cuenta.
      const clear = !created && !stillPendingAfterOk(current?.lastChangeAt ?? null, build.dispatchedAt);
      await tx.carteraSite.update({ where: { id: site.id }, data: { lastPublishedCount: build.homeCount, ...(clear ? { pendingSince: null } : {}) } });
    }
    if (effect.finished || created) {
      await auditCartera(tx, {
        siteId: site.id,
        clientId: site.clientId,
        entity: 'build',
        entityId: build.id,
        action: effect.finished ? 'publish_finished' : 'publish_external',
        actor: 'system',
        metadata: { trigger: build.trigger, status: effect.status, stage: effect.data.stage ?? null, homeCount: build.homeCount },
      });
    }
    const notify =
      effect.finished === 'fallida' && (await isFirstFailureInARow(tx, site.id, build.id))
        ? { buildId: build.id, trigger: build.trigger, stage: effect.data.stage ?? null, error: effect.data.error ?? null }
        : null;
    return { ok: true as const, buildId: build.id, status: effect.status, notify };
  });

  if (!out.ok) return out;
  if (out.notify) {
    await notifyFailure(prisma, { ...out.notify, siteUrl: site.siteUrl, githubRepo: site.githubRepo, runUrl: notice.runUrl, clientId: site.clientId });
  }
  return { ok: true, buildId: out.buildId, status: out.status };
}

/** Solo se avisa del primer fallo de una racha: si el feed sigue roto, cada
 *  reintento fallaría igual y mandaría el mismo correo. */
async function isFirstFailureInARow(db: Db, siteId: string, buildId: string): Promise<boolean> {
  const previous = await db.carteraBuild.findFirst({
    where: { siteId, id: { not: buildId }, status: { in: ['ok', 'fallida'] } },
    orderBy: { dispatchedAt: 'desc' },
    select: { status: true },
  });
  return previous?.status !== 'fallida';
}

/** Un correo a la agencia y otro a Kairikos. Nunca lanza: el resultado ya está guardado. */
export async function notifyFailure(prisma: PrismaClient, info: FailedBuildInfo): Promise<void> {
  try {
    const [client, operators] = await Promise.all([
      prisma.chatbotClient.findUnique({ where: { id: info.clientId }, select: { email: true } }),
      getOperatorAlertRecipients(),
    ]);
    const results = await Promise.all([
      sendCarteraEmail(client?.email, renderAgencyFailedEmail(info)),
      ...operators.map((o) => sendCarteraEmail(o.email, renderOperatorFailedEmail(info))),
    ]);
    for (const r of results) if (!r.ok) logError('cartera.publish_failed_email', r.error, { buildId: info.buildId }, 'warn');
  } catch (err) {
    logError('cartera.publish_failed_email', err, { buildId: info.buildId }, 'warn');
  }
}

// --- El cron ---------------------------------------------------------------------------

/** Las lanzadas o en curso sin noticias en 45 minutos pasan a «desconocida». */
export async function markStaleBuilds(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const candidates = await prisma.carteraBuild.findMany({
    where: { status: { in: [...ACTIVE_BUILD_STATUSES] }, dispatchedAt: { lte: new Date(now.getTime() - UNKNOWN_AFTER_MS) } },
    select: { id: true, siteId: true, status: true, dispatchedAt: true, lastNoticeAt: true, trigger: true, site: { select: { clientId: true } } },
  });
  let marked = 0;
  for (const b of candidates) {
    if (!isStale(b, now)) continue;
    await prisma.$transaction(async (tx) => {
      // Condicional: si el aviso llegó mientras tanto, no se pisa.
      const r = await tx.carteraBuild.updateMany({
        where: { id: b.id, status: b.status },
        data: { status: 'desconocida', finishedAt: now, error: 'Sin noticias de GitHub en 45 minutos: puede que la web se haya publicado o no.' },
      });
      if (r.count === 0) return;
      marked++;
      await auditCartera(tx, { siteId: b.siteId, clientId: b.site.clientId, entity: 'build', entityId: b.id, action: 'publish_unknown', actor: 'system', metadata: { trigger: b.trigger, was: b.status } });
    });
  }
  return marked;
}

export interface CarteraSweepResult {
  stale: number;
  launched: number;
  held: number;
  failed: number;
  skipped: number;
  /** Contactos de más de 24 meses borrados en esta pasada (PR 5). */
  enquiriesPurged: number;
}

/**
 * GET /api/cron/cartera-tick, cada 5 minutos (scripts/scheduler.sh). Idempotente:
 * la lógica de «¿toca ya?» vive en decideLaunch y en isPurgeDue, no en la
 * cadencia. Las bajas (PR 6) se añaden aquí detrás.
 */
export async function sweepCartera(prisma: PrismaClient, now: Date = new Date()): Promise<CarteraSweepResult> {
  const result: CarteraSweepResult = { stale: 0, launched: 0, held: 0, failed: 0, skipped: 0, enquiriesPurged: 0 };
  // Primero la purga: no depende de nada de lo demás y no debe esperar a GitHub.
  try {
    result.enquiriesPurged = (await purgeOldEnquiries(prisma, now)).deleted;
  } catch (err) {
    logError('cartera.sweep_purge', err, {});
  }
  result.stale = await markStaleBuilds(prisma, now);

  const sites = await prisma.carteraSite.findMany({
    where: { pendingSince: { not: null }, githubRepo: { not: null }, clientProduct: { status: 'active' } },
    select: { id: true },
    orderBy: { pendingSince: 'asc' },
  });
  for (const site of sites) {
    try {
      const r = await launchPublication(prisma, site.id, { mode: 'auto', actor: 'system', now });
      if (r.ok) result.launched++;
      else if (r.error === 'dispatch_failed') result.failed++;
      else if (r.error === 'confirm_removal') result.held++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      logError('cartera.sweep_launch', err, { siteId: site.id });
    }
  }
  return result;
}

// --- Lo que lee el panel -----------------------------------------------------------------

/** El estado de la publicación para el panel: las últimas 50, la cuenta de
 *  ahora y si la salvaguarda de vaciado está frenando la automática. */
export async function loadPublicationForPanel(
  db: Db,
  site: { id: string; githubRepo: string | null; siteUrl: string | null; pendingSince: Date | null; lastPublishedCount: number | null },
  contractStatus: string,
) {
  const [builds, homeCount] = await Promise.all([
    db.carteraBuild.findMany({
      where: { siteId: site.id },
      orderBy: { dispatchedAt: 'desc' },
      take: 50,
      select: { id: true, trigger: true, status: true, homeCount: true, dispatchedAt: true, finishedAt: true, runUrl: true, error: true, stage: true },
    }),
    publishableCount(db, site.id),
  ]);
  const guard = removalGuard(homeCount, site.lastPublishedCount);
  return {
    configured: Boolean(site.githubRepo && githubToken()),
    active: contractStatus === 'active',
    pendingSince: site.pendingSince?.toISOString() ?? null,
    homeCount,
    lastPublishedCount: site.lastPublishedCount,
    removing: site.pendingSince && guard.hold ? guard.removing : null,
    siteUrl: site.siteUrl,
    builds: builds.map((b) => ({ ...b, dispatchedAt: b.dispatchedAt.toISOString(), finishedAt: b.finishedAt?.toISOString() ?? null })),
  };
}
