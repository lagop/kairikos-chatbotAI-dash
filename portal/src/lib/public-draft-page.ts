import 'server-only';
import type { PrismaClient, PublicDraftRequest } from '@prisma/client';
import { renderWebDraftHtml, type WebDraftPurchaseCta } from './web-draft-html';
import type { WebDraftCopy } from './web-draft-ai';
import { renderDesignedDraft } from './web-draft-design';
import { publicDraftUploadsBase } from './web-draft-images';

// =============================================================================
// 30/10/2026 — pintar el borrador de una petición de kairikos.com.
//
// Lo comparten /mi-web/<testigo> (lo que ve el negocio) y las vistas del
// operador (/api/admin/portal/borradores/<id>/…), que lo ven ANTES de que se
// envíe (public-draft-delivery.ts). Mismo HTML en los dos sitios: si el
// operador revisa otra cosa que la que llega, revisar no sirve de nada.
// =============================================================================

type PublicDraftRow = Pick<
  PublicDraftRequest,
  'token' | 'businessName' | 'primaryType' | 'city' | 'contact' | 'phone' | 'copy' | 'content' | 'templateId' | 'themeKey' | 'createdAt'
>;

/** El teléfono que se pinta en su web: el que dejó aparte o, en las
 *  peticiones del formulario antiguo, el contacto si ES un teléfono. Un correo
 *  donde debería ir el número queda raro y delata que esto se ha montado solo. */
export function publicDraftPhone(row: Pick<PublicDraftRow, 'contact' | 'phone'>): string | null {
  if (row.phone) return row.phone;
  return /^[+0-9][0-9 ]{7,}$/.test(row.contact) ? row.contact : null;
}

export function publicDraftSubject(row: PublicDraftRow) {
  return {
    businessName: row.businessName,
    primaryType: row.primaryType,
    city: row.city,
    address: null,
    phone: publicDraftPhone(row),
    rating: null,
    reviewCount: null,
  };
}

/** El HTML del borrador, o null si todavía no está escrito. `content` sustituye
 *  al guardado (la vista en vivo del editor). */
export async function renderPublicDraft(
  prisma: PrismaClient,
  row: PublicDraftRow,
  opts: {
    purchase?: WebDraftPurchaseCta | null;
    offer?: Parameters<typeof renderWebDraftHtml>[0]['offer'];
    shareUrl?: string | null;
    edicion?: boolean;
    content?: unknown;
  } = {},
): Promise<string | null> {
  if (!row.copy) return null;
  const subject = publicDraftSubject(row);
  // Webs con IA (27/10/2026): con plantilla de la biblioteca, ese diseño;
  // si no, o si algo falla al pintarla, el borrador de siempre.
  const designed = await renderDesignedDraft(prisma, {
    templateId: row.templateId,
    content: opts.content !== undefined ? opts.content : row.content,
    subject,
    themeKey: row.themeKey,
    purchase: opts.purchase ?? null,
    offer: opts.offer,
    shareUrl: opts.shareUrl ?? null,
    edicion: opts.edicion,
    // 31/10/2026 — las fotos que subió el operador (web-draft-images.ts).
    subidasBase: publicDraftUploadsBase(row.token),
  });
  if (designed) return designed;
  if (opts.content !== undefined) return null;
  return renderWebDraftHtml({
    purchase: opts.purchase ?? null,
    offer: opts.offer,
    subject,
    copy: row.copy as unknown as WebDraftCopy,
    themeKey: row.themeKey,
    generatedAt: row.createdAt,
    shareUrl: opts.shareUrl ?? null,
  });
}
