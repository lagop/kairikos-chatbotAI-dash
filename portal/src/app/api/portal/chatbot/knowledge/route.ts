import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted, resolveContractedInstance } from '@/lib/client-product-access';
import {
  ingestKnowledgeDocument,
  MAX_DOCUMENTS_PER_CHATBOT,
  MAX_DOCUMENT_CHARS,
} from '@/lib/chatbot-knowledge';
import { isCrawlableUrl } from '@/lib/chatbot-knowledge-crawl';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 3 — POST/DELETE /api/portal/chatbot/knowledge
//
// El cliente añade material para su bot: texto que pega, o una página de su
// web para que la rastreemos.
//
// Las dos fuentes acaban en la misma tabla pero NO por el mismo camino: el
// texto pegado se indexa aquí mismo, y la web se encola en 'pending' para
// que la rastree el cron. Descargar una web ajena puede tardar diez
// segundos o no responder, y hacerlo dentro del formulario del cliente
// convertiría una web lenta en un portal que parece roto.
// =============================================================================

const MAX_TITLE = 120;

const BodySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('manual'),
    title: z.string().trim().min(2).max(MAX_TITLE),
    content: z.string().trim().min(20).max(MAX_DOCUMENT_CHARS),
  }),
  z.object({
    source: z.literal('web'),
    url: z.string().trim().min(4).max(2000),
  }),
]);

const DeleteSchema = z.object({ id: z.string().uuid() });

/** Los dos productos que dan acceso a esto son el mismo: la base de
 *  conocimiento es del chatbot y de nadie más. Se comprueba igual que
 *  cualquier otra superficie, con isProductContracted y nunca mirando
 *  tablas a mano. */
async function requireChatbotClient() {
  const session = await getSession();
  if (!session.hasClientAccess) return null;
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return null;
  if (!(await isProductContracted(prisma, resolved.clientId, 'chatbot'))) return null;
  return resolved;
}

/** Fase 4 multi-instancia — añadir material es escribir en la base de UN
 *  chatbot, así que aquí hay que saber cuál. El id llega por query desde la
 *  pantalla de conocimiento de ese chatbot; sin él vale el único que haya, y
 *  con dos se niega en vez de dárselo al equivocado. */
async function requireChatbotInstance(req: NextRequest) {
  const resolved = await requireChatbotClient();
  if (!resolved) return null;
  const instance = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: 'chatbot',
    clientProductId: req.nextUrl.searchParams.get('clientProductId'),
  });
  if (!instance) return null;
  return { resolved, instance };
}

export async function POST(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const auth = await requireChatbotInstance(req);
  if (!auth) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { resolved, instance } = auth;

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  const tenantId = client?.tenantId ?? null;

  try {
    if (body.data.source === 'manual') {
      const result = await ingestKnowledgeDocument(prisma, {
        clientId: resolved.clientId,
        clientProductId: instance.clientProductId,
        tenantId,
        source: 'manual',
        title: body.data.title,
        content: body.data.content,
        actorId: `client:${resolved.clientId}`,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error, limit: MAX_DOCUMENTS_PER_CHATBOT }, { status: 400 });
      }
      return NextResponse.json({ ok: true, documentId: result.documentId, chunks: result.chunks });
    }

    // La URL se valida ANTES de guardar nada: encolar una dirección que el
    // rastreador va a rechazar dejaría al cliente esperando un fallo que ya
    // sabemos ahora.
    const url = normalizeUrl(body.data.url);
    if (!url || !isCrawlableUrl(url)) {
      return NextResponse.json({ error: 'invalid_url' }, { status: 400 });
    }

    // Tope por chatbot, igual que en ingestKnowledgeDocument.
    const existing = await prisma.chatbotKnowledgeDocument.count({
      where: { clientId: resolved.clientId, clientProductId: instance.clientProductId },
    });
    if (existing >= MAX_DOCUMENTS_PER_CHATBOT) {
      return NextResponse.json({ error: 'document_limit_reached', limit: MAX_DOCUMENTS_PER_CHATBOT }, { status: 400 });
    }

    // Sin fragmentos todavía: el título provisional es la propia URL, y el
    // rastreo lo sustituye por el <title> real de la página.
    const created = await prisma.chatbotKnowledgeDocument.create({
      data: {
        clientId: resolved.clientId,
        // El rastreo lo recogerá después y sus fragmentos heredarán esto.
        clientProductId: instance.clientProductId,
        tenantId,
        source: 'web',
        title: url.slice(0, MAX_TITLE),
        sourceUrl: url,
        status: 'pending',
      },
      select: { id: true },
    });

    return NextResponse.json({ ok: true, documentId: created.id, status: 'pending' });
  } catch (err) {
    logError('portal.chatbot_knowledge.save_failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const resolved = await requireChatbotClient();
  if (!resolved) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = DeleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    // deleteMany con el clientId dentro, no delete por id: así un id de
    // otro tenant no borra nada en vez de borrar la fila ajena.
    const deleted = await prisma.chatbotKnowledgeDocument.deleteMany({
      where: { id: body.data.id, clientId: resolved.clientId },
    });
    if (deleted.count === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('portal.chatbot_knowledge.delete_failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  }
}

/** Acepta "peluqueriaaurora.es" además de la URL completa: es como la
 *  escribe un cliente que no piensa en protocolos. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}
