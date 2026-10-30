import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import { parseSiteContent } from './site-content';
import { loadSiteEditorData } from './site-editor-data';
import { DRAFT_HUELLA_SQL, isUuid } from './web-draft-edit';
import { renderPublicDraft } from './public-draft-page';
import type { PreviewOverride } from './website-preview';
import type { DraftEditorLoad } from './web-draft-editor';

// =============================================================================
// 30/10/2026 — el borrador que pidió un negocio en kairikos.com, editado por
// el operador antes de enviárselo (public-draft-delivery.ts).
//
// Es el editor de borradores de prospección (web-draft-editor.ts) sobre otra
// tabla, con lo mismo dentro: se guarda solo `content`, la versión del editor
// es la huella de copy+content, y la vista en vivo pinta como /mi-web.
//
// LIMITACIÓN ACEPTADA: aquí no hay historial. ProspectingWebDraftVersion es de
// los borradores de prospección y PublicDraftRequest no tiene uno propio;
// para un retoque antes de la primera entrega, «Deshacer» del editor cubre lo
// que hace falta. Si estos borradores empiezan a editarse después de enviados,
// es el momento de darles su tabla de versiones.
// =============================================================================

async function huellaOf(db: Prisma.TransactionClient | PrismaClient, id: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ huella: string }[]>(
    Prisma.sql`SELECT ${Prisma.raw(DRAFT_HUELLA_SQL)} AS huella FROM "PublicDraftRequest" d WHERE d.id = ${id}::uuid`,
  );
  return rows[0]?.huella ?? null;
}

export async function loadPublicDraftEditor(prisma: PrismaClient, id: string): Promise<DraftEditorLoad> {
  if (!isUuid(id)) return { ok: false, reason: 'not_found' };
  const row = await prisma.publicDraftRequest.findUnique({
    where: { id },
    select: { businessName: true, copy: true, content: true, templateId: true },
  });
  if (!row?.copy) return { ok: false, reason: 'not_found' };
  if (!row.templateId || row.content == null) return { ok: false, reason: 'old_design' };
  const [data, huella] = await Promise.all([loadSiteEditorData(prisma, { content: row.content, templateId: row.templateId }), huellaOf(prisma, id)]);
  if (!data || !huella) return { ok: false, reason: 'invalid_content' };
  return { ok: true, negocio: row.businessName, huella, data };
}

/** Misma entrada y misma respuesta que saveDraftContent (web-draft-editor.ts). */
export async function savePublicDraftContent(
  prisma: PrismaClient,
  id: string,
  input: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isUuid(id)) return { status: 404, body: { error: 'not_found' } };
  const raw = (input ?? {}) as Record<string, unknown>;
  const base = typeof raw.baseUpdatedAt === 'string' ? raw.baseUpdatedAt : '';
  if (!/^[0-9a-f]{32}$/.test(base)) return { status: 400, body: { error: 'invalid_body' } };
  const parsed = parseSiteContent(raw.content);
  if (!parsed.ok) return { status: 400, body: { error: 'invalid_content', issues: parsed.issues.slice(0, 20) } };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ template_id: string | null }[]>(
      Prisma.sql`SELECT d.template_id FROM "PublicDraftRequest" d WHERE d.id = ${id}::uuid AND ${Prisma.raw(DRAFT_HUELLA_SQL)} = ${base} FOR UPDATE`,
    );
    if (locked.length === 0) {
      const exists = await tx.publicDraftRequest.findUnique({ where: { id }, select: { id: true } });
      return exists ? { status: 409, body: { error: 'stale_draft' } } : { status: 404, body: { error: 'not_found' } };
    }
    if (!locked[0].template_id) return { status: 409, body: { error: 'old_design' } };
    await tx.publicDraftRequest.update({ where: { id }, data: { content: parsed.content as unknown as Prisma.InputJsonValue } });
    return { status: 200, body: { ok: true, updatedAt: await huellaOf(tx, id) } };
  });
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

/** La vista en vivo del editor: lo escrito sin guardar, en modo edición. */
export async function servePublicDraftPreview(prisma: PrismaClient, id: string, override: PreviewOverride): Promise<NextResponse> {
  const text = (body: string, status: number) => new NextResponse(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!isUuid(id)) return text('No encontrado.', 404);
  const row = await prisma.publicDraftRequest.findUnique({ where: { id } });
  if (!row?.copy || !row.templateId) return text('No encontrado.', 404);
  const html = await renderPublicDraft(prisma, row, { content: override.content, edicion: true });
  if (!html) return text('No se puede pintar este contenido.', 422);
  return htmlResponse(html);
}

/** El borrador tal como lo verá el negocio, ANTES de enviárselo, con el
 *  enlace suyo en la banda (que hasta el envío solo dice «lo preparamos»). */
export async function servePublicDraftReview(prisma: PrismaClient, id: string, origin: string): Promise<NextResponse> {
  const text = (body: string, status: number) => new NextResponse(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!isUuid(id)) return text('No encontrado.', 404);
  const row = await prisma.publicDraftRequest.findUnique({ where: { id } });
  if (!row) return text('No encontrado.', 404);
  const html = await renderPublicDraft(prisma, row, { shareUrl: `${origin}/mi-web/${row.token}` });
  if (!html) return text('Todavía no está escrito: se está generando. Vuelve en unos minutos.', 404);
  return htmlResponse(html);
}
