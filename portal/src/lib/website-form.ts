import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hasLeadsInboxAccess } from './leads';
import { sendNewLeadEmail } from './leads-email';
import { logError } from './observability';

// =============================================================================
// Producto Web, Fase 1 — el formulario de contacto de la web publicada.
//
// Esto rompe A PROPÓSITO la regla de "el sitio publicado no le pide nada al
// portal", y conviene entender hasta dónde: la web se ve siempre, con o sin
// nosotros, porque el HTML y la foto viven en el servidor del cliente. Lo
// único que necesita el portal es ENVIAR el formulario. Si nuestra VPS cae,
// su web sigue en pie y el formulario enseña el teléfono en lugar de fallar
// en silencio (ver el script de la plantilla).
//
// DOS DESTINOS, según lo que tenga contratado:
//
//   con leads (o prospecting, que comparte bandeja) → entra en su bandeja,
//     con su estado, su auditoría y sus avisos, como cualquier otro lead.
//   sin leads → correo al cliente, y ya está.
//
// No se le mete un lead en una bandeja que no ha comprado, y tampoco se
// pierde el contacto por no haberla comprado. Quien no tiene `leads` recibe
// su aviso por correo, que es lo que esperaría de una web normal.
// =============================================================================

/** Hasta 20 envíos por hora y por sitio. Un formulario público es un buzón
 *  abierto: sin tope, un bot deja cien basuras en la bandeja del cliente en
 *  un minuto y le hace desconfiar del producto entero. Veinte es más de lo
 *  que recibe una pyme en un día bueno. */
export const MAX_SUBMISSIONS_PER_HOUR = 20;

export function createFormToken(): string {
  return randomBytes(24).toString('hex');
}

export function isFormToken(value: string): boolean {
  return /^[0-9a-f]{48}$/.test(value);
}

export interface WebsiteFormSubmission {
  name: string;
  contact: string;
  message: string;
}

export type WebsiteFormResult =
  | { ok: true; destination: 'leads' | 'email' | 'email_skipped' }
  | { ok: false; error: 'not_found' | 'rate_limited' | 'invalid' };

/** Un contacto utilizable: o parece un teléfono, o parece un correo. Sin uno
 *  de los dos, el aviso llega y el cliente no puede responder, que es peor
 *  que no recibirlo. */
export function classifyContact(value: string): { phone: string | null; email: string | null } {
  const trimmed = value.trim();
  if (trimmed.includes('@') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return { phone: null, email: trimmed };
  }
  const digits = trimmed.replace(/[^0-9+]/g, '');
  return digits.length >= 9 ? { phone: digits, email: null } : { phone: null, email: null };
}

export async function handleWebsiteFormSubmission(
  prisma: PrismaClient,
  formToken: string,
  submission: WebsiteFormSubmission,
  now: Date = new Date(),
): Promise<WebsiteFormResult> {
  const website = await prisma.clientWebsite.findUnique({
    where: { formToken },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      businessName: true,
      client: { select: { email: true, name: true } },
    },
  });
  if (!website) return { ok: false, error: 'not_found' };

  const contact = classifyContact(submission.contact);
  if (!contact.phone && !contact.email) return { ok: false, error: 'invalid' };

  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const recent = await prisma.lead.count({
    where: { clientId: website.clientId, channel: 'web', createdAt: { gte: since } },
  });
  if (recent >= MAX_SUBMISSIONS_PER_HOUR) return { ok: false, error: 'rate_limited' };

  const summary = submission.message.trim().slice(0, 2000) || 'Contacto desde su web.';

  if (await hasLeadsInboxAccess(prisma, website.clientId)) {
    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          clientId: website.clientId,
          tenantId: website.tenantId,
          source: 'inbound',
          channel: 'web',
          status: 'nuevo',
          contactName: submission.name.trim().slice(0, 200) || null,
          contactPhone: contact.phone,
          contactEmail: contact.email,
          summary,
        },
      });
      await tx.leadAudit.create({
        data: {
          leadId: lead.id,
          clientId: website.clientId,
          tenantId: website.tenantId,
          action: 'created',
          statusBefore: null,
          statusAfter: 'nuevo',
          actorId: 'system:website-form',
        },
      });
    });
    return { ok: true, destination: 'leads' };
  }

  // Sin bandeja contratada: correo y punto. El envío es best-effort por
  // diseño (ver CLAUDE.md), así que un fallo se registra y NO se le devuelve
  // al visitante como error — desde su lado, el mensaje salió.
  const sent = await sendNewLeadEmail({
    to: website.client.email,
    businessName: website.client.name ?? website.businessName,
    contactName: submission.name.trim() || null,
    contactPhone: contact.phone,
    contactEmail: contact.email,
    summary,
    channel: 'web',
    score: null,
    scoreReason: null,
  });
  if (!sent.ok) {
    logError('website_form.email_failed', new Error(sent.error), { websiteId: website.id }, 'warn');
    return { ok: true, destination: 'email_skipped' };
  }
  return { ok: true, destination: 'skipped' in sent ? 'email_skipped' : 'email' };
}
