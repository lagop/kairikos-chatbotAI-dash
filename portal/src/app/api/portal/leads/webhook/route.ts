import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { hasLeadsInboxAccess } from '@/lib/leads';
import { generateWebhookSecret } from '@/lib/lead-webhook';
import { isCrawlableUrl } from '@/lib/chatbot-knowledge-crawl';
import { logError } from '@/lib/observability';
import { decryptLeadWebhook, encryptLeadWebhook, isLeadWebhookCryptoConfigured } from '@/lib/lead-webhook-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 4 — PUT/DELETE /api/portal/leads/webhook
//
// Dónde quiere el cliente que le lleguen sus leads.
//
// El secreto lo genera el servidor y solo se devuelve al guardarlo: el
// cliente lo copia en su CRM en ese momento. Volver a pedirlo devuelve la
// URL pero no el secreto — si lo pierde, se regenera, que es más honesto
// que tenerlo a la vista para siempre en una pantalla que se comparte por
// captura de pantalla más de lo que nadie admite.
//
// La URL pasa por isCrawlableUrl, el mismo filtro que la base de
// conocimiento: sin él, un cliente puede hacernos llamar a
// http://localhost:5432 y usar nuestro servidor como sonda de su red. Es
// el mismo riesgo y no merece una segunda implementación.
// =============================================================================

const BodySchema = z.object({
  url: z.string().trim().min(4).max(2000),
  enabled: z.boolean().optional(),
  /** Fuerza un secreto nuevo. Lo pide el cliente cuando ha perdido el
   *  suyo o sospecha que se ha filtrado. */
  rotateSecret: z.boolean().optional(),
});

async function requireLeadsClient() {
  const session = await getSession();
  if (!session.hasClientAccess) return null;
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return null;
  if (!(await hasLeadsInboxAccess(prisma, resolved.clientId))) return null;
  return resolved;
}

export async function PUT(req: NextRequest) {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const resolved = await requireLeadsClient();
  if (!resolved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const url = normalizeUrl(body.data.url);
  if (!url || !isCrawlableUrl(url)) {
    return NextResponse.json({ error: 'invalid_url' }, { status: 400 });
  }

  // Sin la clave de cifrado no se guarda nada en claro: mejor un 503 que la
  // URL con su token en la base de datos (ver lead-webhook-crypto.ts).
  if (!isLeadWebhookCryptoConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  try {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tenantId: true },
    });
    const existing = await prisma.leadWebhook.findUnique({ where: { clientId: resolved.clientId } });

    // El secreto se conserva salvo que lo pida: cambiar de URL no debe
    // romperle la comprobación de firma que ya tenía montada.
    const previous = existing ? decryptLeadWebhook(existing) : null;
    // Si el anterior no se puede descifrar (se guardó sin cifrar, o con otra
    // clave), se genera uno nuevo y se le enseña: es el mismo caso que
    // «lo he perdido».
    const secret = previous && !body.data.rotateSecret ? previous.secret : generateWebhookSecret();
    const isNewSecret = !previous || Boolean(body.data.rotateSecret);
    const cifrado = encryptLeadWebhook(url, secret);

    const saved = await prisma.leadWebhook.upsert({
      where: { clientId: resolved.clientId },
      create: {
        clientId: resolved.clientId,
        tenantId: client?.tenantId ?? null,
        ...cifrado,
        enabled: body.data.enabled ?? true,
      },
      update: {
        ...cifrado,
        // Las columnas en claro de antes del cifrado, vacías.
        url: null,
        secret: null,
        enabled: body.data.enabled ?? true,
        // La URL cambió: el último error se refiere a la anterior.
        ...(previous?.url !== url ? { lastDeliveryError: null } : {}),
      },
      select: { enabled: true },
    });

    return NextResponse.json({
      ok: true,
      url,
      enabled: saved.enabled,
      // Solo cuando es nuevo. Un secreto que se puede volver a leer con un
      // GET deja de ser un secreto en cuanto alguien enseña la pantalla.
      secret: isNewSecret ? secret : null,
    });
  } catch (err) {
    logError('portal.lead_webhook.save_failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
}

export async function DELETE() {
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const resolved = await requireLeadsClient();
  if (!resolved) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  try {
    await prisma.leadWebhook.deleteMany({ where: { clientId: resolved.clientId } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('portal.lead_webhook.delete_failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  }
}

/** Acepta 'micrm.example/hooks/kairikos' además de la URL completa: es como
 *  la pega alguien que copia de la pantalla de su CRM. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}
