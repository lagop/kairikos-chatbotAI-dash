import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { DEFAULT_TENANT_ID } from './tenant';

// =============================================================================
// Alta manual de cliente desde el panel de operador.
//
// Hasta hoy el único camino que creaba una fila ChatbotClient era
// POST /api/public/intake — el formulario de kairikos.com. Una venta
// cerrada por teléfono o email, sin pasar por ese formulario, no tenía
// ningún sitio en el panel donde darse de alta.
//
// Deliberadamente más sencillo que el intake: sin carpeta de Drive, sin
// issue de Paperclip, sin sembrado del asistente de configuración desde
// un payload de cualificación — esos tres efectos dependen de datos
// ricos del formulario de marketing (sector, respuestas del Tally) que
// un alta manual del operador no tiene. Lo que sí comparte con el
// intake: el cliente nace en el tenant por defecto (WP-09 — no existe
// todavía un flujo de alta multi-tenant) y su ChatbotClientUser/User se
// crean con passwordHash=null, el mismo estado "pendiente de configurar"
// que ya reconoce POST /api/portal/setup-password — para que el correo
// de activación (sendSetupPassword, auth-email.ts) funcione sin más.
// =============================================================================

export interface CreateClientByOperatorInput {
  email: string;
  name: string;
  companyName: string;
}

export type CreateClientByOperatorResult =
  | { ok: true; clientId: string; clientUserId: string; isNewClient: boolean }
  | { ok: false; error: 'client_already_exists' };

const DEFAULT_TIER = 'starter';
const DEFAULT_STATE = 'in-progress';

/**
 * Crea la ficha de un cliente nuevo, con su usuario de acceso al portal
 * (sin contraseña — el operador dispara el correo de activación por
 * separado, POST /api/admin/portal/clients/[id]/send-setup-email, ya
 * existente). Idempotente por email: si ya existe un ChatbotClient con
 * ese correo, no lo toca — un alta manual no es el sitio para fusionar
 * silenciosamente con una cuenta que ya tenía historial propio.
 */
export async function createClientByOperator(
  prisma: PrismaClient,
  input: CreateClientByOperatorInput,
): Promise<CreateClientByOperatorResult> {
  const normalizedEmail = input.email.toLowerCase().trim();

  const existingClient = await prisma.chatbotClient.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existingClient) {
    return { ok: false, error: 'client_already_exists' };
  }

  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.chatbotClient.create({
      data: {
        email: normalizedEmail,
        name: input.name,
        companyName: input.companyName,
        tier: DEFAULT_TIER,
        state: DEFAULT_STATE,
        tenantId: DEFAULT_TENANT_ID,
      },
      select: { id: true },
    });

    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        role: 'client',
        passwordHash: null,
      },
      select: { id: true },
    });

    const clientUser = await tx.chatbotClientUser.create({
      data: {
        nextAuthEmail: normalizedEmail,
        clientId: client.id,
        userId: user.id,
        tenantId: DEFAULT_TENANT_ID,
      },
      select: { id: true },
    });

    return { clientId: client.id, clientUserId: clientUser.id };
  });

  return { ok: true, ...result, isNewClient: true };
}
