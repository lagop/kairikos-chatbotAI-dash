import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateInternalRequest, internalAuthFailureResponse } from '@/lib/internal-auth';
import type { WebDraftCopy } from '@/lib/web-draft-ai';
import { designForDraft } from '@/lib/web-draft-design';
import { isUuid } from '@/lib/web-draft-edit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/internal/prospecting/web-drafts/[leadId]/design (28/10/2026)
//
// Propone el diseño de la biblioteca para un borrador que ya existe, con SU
// texto: el `convertir` de scripts/borrador-web.ts. Los borradores generados
// antes de que su sector tuviera plantilla aprobada salen con el diseño
// antiguo, y la única forma de pasarlos era regenerarlos — otro texto entero
// (el prospecto que ya lo vio no reconoce su web) y una llamada a Sonnet.
// Aquí solo se amplía el texto guardado al contenido de la plantilla (Haiku,
// menos de un céntimo), igual que al generar (designForDraft).
//
// NO GUARDA. Devuelve la propuesta y el guardado va por el `guardar` de
// siempre de la herramienta, con su validación, su huella y su historial:
// proponer y persistir son dos pasos (CLAUDE.md), y así no hay un segundo
// camino de escritura que mantener.
//
// Interna y no de operador porque la usa la herramienta desde la VPS
// (`docker exec` en el contenedor, con la clave que ya tiene en su entorno):
// el operador no tiene una sesión que darle a un script. El negocio sale del
// leadId de la ruta, nunca del cuerpo.
// =============================================================================

const BodySchema = z.object({ templateId: z.string().refine(isUuid).optional() }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ leadId: string }> }) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { leadId } = await ctx.params;
  const body = BodySchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!isUuid(leadId) || !body.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { contactName: true, primaryType: true, searchLocation: true, webDraft: { select: { copy: true, themeKey: true } } },
  });
  if (!lead?.webDraft) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const businessName = lead.contactName?.trim();
  if (!businessName) return NextResponse.json({ error: 'lead_without_name' }, { status: 422 });

  const design = await designForDraft(prisma, {
    copy: lead.webDraft.copy as unknown as WebDraftCopy,
    themeKey: lead.webDraft.themeKey,
    businessName,
    primaryType: lead.primaryType,
    city: lead.searchLocation,
    templateId: body.data.templateId,
  });
  // Sin plantilla aprobada para su sector (o la pedida no lo está, o no es de
  // su sector). designForDraft no distingue un fallo de esto: lo registra.
  if (!design) return NextResponse.json({ error: 'no_approved_template' }, { status: 409 });

  return NextResponse.json({ templateId: design.templateId, expanded: design.expanded, content: design.content });
}
