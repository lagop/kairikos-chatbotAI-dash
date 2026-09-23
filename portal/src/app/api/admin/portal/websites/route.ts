import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { themeFor } from '@/lib/web-draft-html';
import { createFormToken } from '@/lib/website-form';
import type { WebDraftCopy } from '@/lib/web-draft-ai';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  clientProductId: z.string().uuid(),
  /** Cuando el sitio nace de un borrador de prospección: se copian textos,
   *  plantilla y datos del negocio. Es el camino normal — el prospecto ya
   *  vio esa página y por eso compró. */
  fromLeadId: z.string().uuid().optional(),
  businessName: z.string().trim().min(1).max(200).optional(),
});

/**
 * POST /api/admin/portal/websites
 *
 * Da de alta el sitio de una unidad contratada de 'web'. Una fila por
 * clientProductId, no por cliente: 'web' es multi-instancia porque la
 * segunda web cuesta dinero cada mes.
 *
 * Sin TOTP: crear un sitio en borrador no compromete nada. Publicar sí, y
 * ese es otro endpoint.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const clientProduct = await prisma.clientProduct.findUnique({
    where: { id: body.data.clientProductId },
    select: { id: true, clientId: true, tenantId: true, product: { select: { code: true } } },
  });
  if (!clientProduct) return NextResponse.json({ error: 'client_product_not_found' }, { status: 404 });
  if (clientProduct.product.code !== 'web') {
    return NextResponse.json({ error: 'not_a_web_product' }, { status: 422 });
  }

  // Los textos y la plantilla salen del borrador cuando lo hay. Copiados, no
  // referenciados: a partir del alta, el sitio del cliente y el borrador de
  // prospección tienen vidas distintas — él editará el suyo y el borrador se
  // queda como estaba el día que se lo enseñamos.
  let seed: {
    businessName: string;
    phone: string | null;
    address: string | null;
    city: string | null;
    primaryType: string | null;
    themeKey: string;
    copy: WebDraftCopy;
  } | null = null;

  if (body.data.fromLeadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: body.data.fromLeadId },
      select: {
        clientId: true,
        contactName: true,
        contactPhone: true,
        summary: true,
        primaryType: true,
        searchLocation: true,
        webDraft: { select: { copy: true, themeKey: true } },
      },
    });
    if (!lead?.webDraft) return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
    seed = {
      businessName: body.data.businessName ?? lead.contactName ?? 'Sin nombre',
      phone: lead.contactPhone,
      address: lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
      city: lead.searchLocation,
      primaryType: lead.primaryType,
      themeKey: lead.webDraft.themeKey,
      copy: lead.webDraft.copy as unknown as WebDraftCopy,
    };
  }

  if (!seed && !body.data.businessName) {
    return NextResponse.json({ error: 'business_name_required' }, { status: 400 });
  }

  const operator = auth.operatorId === 'legacy' ? null : await prisma.operator.findUnique({
    where: { id: auth.operatorId },
    select: { email: true },
  });

  try {
    const website = await prisma.$transaction(async (tx) => {
      const row = await tx.clientWebsite.create({
        data: {
          clientId: clientProduct.clientId,
          clientProductId: clientProduct.id,
          tenantId: clientProduct.tenantId,
          businessName: seed?.businessName ?? body.data.businessName!,
          phone: seed?.phone ?? null,
          address: seed?.address ?? null,
          city: seed?.city ?? null,
          primaryType: seed?.primaryType ?? null,
          themeKey: seed?.themeKey ?? `${themeFor(seed?.primaryType ?? null).key}-1`,
          copy: (seed?.copy ?? {
            headline: seed?.businessName ?? body.data.businessName!,
            subheadline: '',
            about: '',
            services: [],
            callToAction: '',
          }) as unknown as object,
          status: 'draft',
          formToken: createFormToken(),
        },
      });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: row.id,
          clientId: row.clientId,
          tenantId: row.tenantId,
          action: 'created',
          after: { fromLeadId: body.data.fromLeadId ?? null, themeKey: row.themeKey },
          actorType: 'operator',
          actorOperatorId: auth.operatorId === 'legacy' ? null : auth.operatorId,
          actorEmail: operator?.email ?? null,
        },
      });
      return row;
    });
    return NextResponse.json({ ok: true, websiteId: website.id }, { status: 201 });
  } catch (err) {
    // El índice único por clientProductId es el que impide dos sitios para la
    // misma unidad contratada. Es un choque esperable (dos pestañas), no un
    // fallo: se responde 409 y no 500.
    logError('client_website.create_failed', err, { clientProductId: body.data.clientProductId }, 'warn');
    return NextResponse.json({ error: 'website_already_exists' }, { status: 409 });
  }
}
