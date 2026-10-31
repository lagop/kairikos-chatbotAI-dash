import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { isUuid } from './web-draft-edit';

// =============================================================================
// 31/10/2026 — «Versiones anteriores» en los dos editores de borradores.
//
// Los de prospección ya guardaban cada estado anterior
// (ProspectingWebDraftVersion), pero solo se podía mirar y volver atrás con la
// herramienta de Claude Code (borrador-web.ts historial / restaurar). Los
// pedidos en kairikos.com no tenían historial: public-draft-editor.ts lo dejó
// escrito como limitación aceptada «hasta que se editen después de enviados»,
// y desde que se suben fotos y se retocan con calma ya pasa. Ahora tienen su
// tabla (PublicDraftVersion) y los dos se ven y se restauran desde el editor.
//
// Volver a una versión hace lo mismo que draftRestoreSql: lo de ahora pasa
// antes al historial como 'restaurado', así que volver también se deshace. La
// huella del borrador cambia, y un editor abierto con la de antes recibe 409
// stale_draft al guardar en vez de pisar lo restaurado.
// =============================================================================

export type DraftVersionOwner = { kind: 'prospecting'; leadId: string } | { kind: 'public'; id: string };

export interface DraftVersionRow {
  id: string;
  accion: string;
  nota: string | null;
  /** El correo del operador, «Claude Code» para la herramienta, o null. */
  autor: string | null;
  createdAt: string;
  /** False si es del diseño antiguo (sin plantilla): se puede volver a ella,
   *  pero el editor ya no lo abrirá. */
  conPlantilla: boolean;
}

/** Cuántas se enseñan: el historial no se poda, pero nadie vuelve a la 40.ª. */
const LIST_LIMIT = 30;

type Db = PrismaClient | Prisma.TransactionClient;
type VersionData = { copy: unknown; content: unknown; templateId: string | null; themeKey: string };

async function draftIdOf(db: Db, owner: DraftVersionOwner): Promise<string | null> {
  if (owner.kind === 'public') return isUuid(owner.id) ? owner.id : null;
  if (!isUuid(owner.leadId)) return null;
  return (await db.prospectingWebDraft.findUnique({ where: { leadId: owner.leadId }, select: { id: true } }))?.id ?? null;
}

async function autores(prisma: PrismaClient, ids: string[]): Promise<Map<string, string>> {
  const uuids = [...new Set(ids.filter(isUuid))];
  const found = uuids.length ? await prisma.operator.findMany({ where: { id: { in: uuids } }, select: { id: true, email: true } }) : [];
  return new Map(found.map((o) => [o.id, o.email]));
}

export async function listDraftVersions(prisma: PrismaClient, owner: DraftVersionOwner): Promise<DraftVersionRow[]> {
  const draftId = await draftIdOf(prisma, owner);
  if (!draftId) return [];
  const select = { id: true, accion: true, nota: true, actorId: true, createdAt: true, templateId: true, content: true } as const;
  const rows =
    owner.kind === 'prospecting'
      ? await prisma.prospectingWebDraftVersion.findMany({ where: { draftId }, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT, select })
      : await prisma.publicDraftVersion.findMany({ where: { requestId: draftId }, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT, select });
  const emails = await autores(prisma, rows.map((r) => r.actorId));
  return rows.map((r) => ({
    id: r.id,
    accion: r.accion,
    nota: r.nota,
    autor: r.actorId.startsWith('system:') ? 'Claude Code' : (emails.get(r.actorId) ?? null),
    createdAt: r.createdAt.toISOString(),
    conPlantilla: Boolean(r.templateId) && r.content != null,
  }));
}

const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/** Deja en el historial el estado de ahora del borrador de kairikos.com. Lo
 *  usa el guardado del editor (public-draft-editor.ts) y la restauración. */
export async function snapshotPublicDraft(tx: Prisma.TransactionClient, id: string, accion: string, actorId: string, nota: string | null = null) {
  const now = await tx.publicDraftRequest.findUniqueOrThrow({ where: { id }, select: { copy: true, content: true, templateId: true, themeKey: true } });
  await tx.publicDraftVersion.create({
    data: { requestId: id, accion, nota, actorId, copy: json(now.copy), content: json(now.content), templateId: now.templateId, themeKey: now.themeKey },
  });
}

/** Vuelve a una versión. 404 si la versión no es de este borrador. */
export async function restoreDraftVersion(
  prisma: PrismaClient,
  owner: DraftVersionOwner,
  versionId: string,
  actorId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isUuid(versionId)) return { status: 404, body: { error: 'not_found' } };
  return prisma.$transaction(async (tx) => {
    const draftId = await draftIdOf(tx, owner);
    if (!draftId) return { status: 404, body: { error: 'not_found' } };
    const nota = `antes de volver a la versión ${versionId}`;

    if (owner.kind === 'prospecting') {
      // Bloquea la fila: dos restauraciones a la vez dejarían el historial
      // con dos «antes» del mismo estado.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "ProspectingWebDraft" WHERE id = ${draftId}::uuid FOR UPDATE`);
      const v = await tx.prospectingWebDraftVersion.findFirst({ where: { id: versionId, draftId } });
      if (!v) return { status: 404, body: { error: 'not_found' } };
      const now = await tx.prospectingWebDraft.findUniqueOrThrow({ where: { id: draftId }, select: { copy: true, content: true, templateId: true, themeKey: true } });
      await tx.prospectingWebDraftVersion.create({
        data: { draftId, accion: 'restaurado', nota, actorId, copy: now.copy as Prisma.InputJsonValue, content: json(now.content), templateId: now.templateId, themeKey: now.themeKey },
      });
      await tx.prospectingWebDraft.update({ where: { id: draftId }, data: { ...restored(v), copy: v.copy as Prisma.InputJsonValue } });
      return { status: 200, body: { ok: true } };
    }

    await tx.$queryRaw(Prisma.sql`SELECT id FROM "PublicDraftRequest" WHERE id = ${draftId}::uuid FOR UPDATE`);
    const v = await tx.publicDraftVersion.findFirst({ where: { id: versionId, requestId: draftId } });
    if (!v) return { status: 404, body: { error: 'not_found' } };
    await snapshotPublicDraft(tx, draftId, 'restaurado', actorId, nota);
    await tx.publicDraftRequest.update({ where: { id: draftId }, data: { ...restored(v), copy: json(v.copy) } });
    return { status: 200, body: { ok: true } };
  });
}

/** Los cuatro campos de la versión, tal cual. */
function restored(v: VersionData) {
  return { content: json(v.content), templateId: v.templateId, themeKey: v.themeKey };
}
