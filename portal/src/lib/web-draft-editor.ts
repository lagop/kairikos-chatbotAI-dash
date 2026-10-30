import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import { parseSiteContent } from './site-content';
import { loadSiteEditorData } from './site-editor-data';
import type { WebDraftCopy } from './web-draft-ai';
import { renderDesignedDraft } from './web-draft-design';
import { DRAFT_HUELLA_SQL, isUuid } from './web-draft-edit';
import { getLiveDraftData } from './web-draft-live';
import { leadDraftSubject } from './web-draft-subject';
import type { PreviewOverride } from './website-preview';

// =============================================================================
// 30/10/2026 — el borrador de un prospecto, editado por el operador con el
// MISMO editor que la web de un cliente (SiteContentEditor).
//
// Orlando preguntó si podía ajustar un borrador antes de mandárselo al
// negocio. Podía, pero solo pidiéndomelo: scripts/borrador-web.ts pasa por
// SSH y SQL. El editor del cliente ya hacía todo lo demás (vista en vivo,
// texto pulsable, deshacer), así que aquí solo hay lo que cambia:
//
// - Se guarda `content` y nada más. `copy` es el texto de la generación y
//   del diseño antiguo; la plantilla la elige el reparto (o «Regenerar»).
// - Cada «Guardar» deja el estado ANTERIOR en ProspectingWebDraftVersion
//   ('editado', con el id del operador), igual que la herramienta, así que
//   se puede volver atrás con `borrador-web.ts restaurar`.
// - La versión que el editor cree tener es la HUELLA de la herramienta
//   (web-draft-edit.ts), no una fecha: la fila no tiene updatedAt, y así el
//   editor y la herramienta se protegen el uno del otro. Si alguien regenera
//   o retoca el borrador mientras está abierto, «Guardar» se niega (409).
// - La vista en vivo pinta como /borrador (renderDesignedDraft, con lo de
//   Google en vivo y la banda de Kairikos), en modo edición. Lo de Google
//   tiene caché de una hora por negocio (web-draft-live.ts): escribir no gasta
//   una consulta por tecla.
//
// Lo que el editor de borradores NO hace, a propósito: publicar, «Mis datos»
// (el teléfono y la dirección salen de Google), páginas interiores ni blog
// (el borrador es solo la portada, ver borrador-solo-portada) y subir fotos
// (no hay dónde guardarlas: las subidas son de una web, ClientWebsiteImage).
// =============================================================================

const LEAD_SELECT = {
  contactName: true,
  contactPhone: true,
  summary: true,
  primaryType: true,
  searchLocation: true,
  externalPlaceId: true,
  competitorSnapshot: { select: { subjectRating: true, subjectReviewCount: true } },
  webDraft: { select: { id: true, copy: true, content: true, templateId: true, themeKey: true } },
} as const;

type EditorData = NonNullable<Awaited<ReturnType<typeof loadSiteEditorData>>>;

export type DraftEditorLoad =
  | { ok: true; negocio: string; huella: string; data: EditorData }
  /** not_found: ni prospecto ni borrador. old_design: el borrador sale del
   *  diseño antiguo (sin plantilla), que no tiene contenido que editar. */
  | { ok: false; reason: 'not_found' | 'old_design' | 'invalid_content' };

async function huellaOf(db: Prisma.TransactionClient | PrismaClient, leadId: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ huella: string }[]>(
    Prisma.sql`SELECT ${Prisma.raw(DRAFT_HUELLA_SQL)} AS huella FROM "ProspectingWebDraft" d WHERE d.lead_id = ${leadId}::uuid`,
  );
  return rows[0]?.huella ?? null;
}

/** Lo que necesita la página del editor de un borrador. */
export async function loadDraftEditor(prisma: PrismaClient, leadId: string): Promise<DraftEditorLoad> {
  if (!isUuid(leadId)) return { ok: false, reason: 'not_found' };
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: LEAD_SELECT });
  const draft = lead?.webDraft;
  if (!lead?.contactName || !draft) return { ok: false, reason: 'not_found' };
  if (!draft.templateId || draft.content == null) return { ok: false, reason: 'old_design' };
  const [data, huella] = await Promise.all([loadSiteEditorData(prisma, { content: draft.content, templateId: draft.templateId }), huellaOf(prisma, leadId)]);
  if (!data || !huella) return { ok: false, reason: 'invalid_content' };
  return { ok: true, negocio: lead.contactName, huella, data };
}

/**
 * Guarda el contenido que manda el editor ({ content, baseUpdatedAt }, donde
 * baseUpdatedAt es la huella con la que se abrió). Misma forma de respuesta
 * que website-content-save.ts, que es la que entiende el editor.
 */
export async function saveDraftContent(
  prisma: PrismaClient,
  leadId: string,
  input: unknown,
  operatorId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isUuid(leadId)) return { status: 404, body: { error: 'not_found' } };
  const raw = (input ?? {}) as Record<string, unknown>;
  const base = typeof raw.baseUpdatedAt === 'string' ? raw.baseUpdatedAt : '';
  if (!/^[0-9a-f]{32}$/.test(base)) return { status: 400, body: { error: 'invalid_body' } };
  const parsed = parseSiteContent(raw.content);
  if (!parsed.ok) return { status: 400, body: { error: 'invalid_content', issues: parsed.issues.slice(0, 20) } };

  return prisma.$transaction(async (tx) => {
    // Bloquea la fila y comprueba que sigue como se abrió.
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT d.id FROM "ProspectingWebDraft" d WHERE d.lead_id = ${leadId}::uuid AND ${Prisma.raw(DRAFT_HUELLA_SQL)} = ${base} FOR UPDATE`,
    );
    if (locked.length === 0) {
      const exists = await tx.prospectingWebDraft.findUnique({ where: { leadId }, select: { id: true } });
      return exists ? { status: 409, body: { error: 'stale_draft' } } : { status: 404, body: { error: 'not_found' } };
    }
    const old = await tx.prospectingWebDraft.findUniqueOrThrow({ where: { leadId }, select: { id: true, copy: true, content: true, templateId: true, themeKey: true } });
    // Un borrador del diseño antiguo no tiene plantilla con la que pintar
    // contenido: guardarlo lo dejaría como estaba, sin avisar.
    if (!old.templateId) return { status: 409, body: { error: 'old_design' } };
    await tx.prospectingWebDraftVersion.create({
      data: {
        draftId: old.id,
        accion: 'editado',
        actorId: operatorId,
        copy: old.copy as Prisma.InputJsonValue,
        content: old.content === null ? Prisma.DbNull : (old.content as Prisma.InputJsonValue),
        templateId: old.templateId,
        themeKey: old.themeKey,
      },
    });
    await tx.prospectingWebDraft.update({ where: { leadId }, data: { content: parsed.content as unknown as Prisma.InputJsonValue } });
    return { status: 200, body: { ok: true, updatedAt: await huellaOf(tx, leadId) } };
  });
}

/** La vista en vivo: el borrador pintado como /borrador, con el contenido
 *  sin guardar, en modo edición. Solo la portada. */
export async function serveDraftPreview(prisma: PrismaClient, leadId: string, override: PreviewOverride): Promise<NextResponse> {
  const text = (body: string, status: number) => new NextResponse(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!isUuid(leadId)) return text('No encontrado.', 404);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: LEAD_SELECT });
  const draft = lead?.webDraft;
  if (!lead?.contactName || !draft?.templateId) return text('No encontrado.', 404);
  const copy = draft.copy as unknown as WebDraftCopy;
  const live = await getLiveDraftData(lead.externalPlaceId);
  const html = await renderDesignedDraft(prisma, {
    templateId: draft.templateId,
    content: override.content,
    subject: leadDraftSubject({ ...lead, contactName: lead.contactName }, live, copy),
    themeKey: draft.themeKey,
    edicion: true,
  });
  // Null: el contenido no valida (el editor lo enseña como «algún campo no
  // cuadra») o la plantilla ya no está.
  if (!html) return text('No se puede pintar este contenido.', 422);
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
