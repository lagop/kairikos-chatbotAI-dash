import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Fase 4 multi-instancia — de qué chatbot habla una pantalla del portal
// (canales, conocimiento, conversaciones).
//
// El asistente de configuración eligió `?clientProductId=` en la URL, y estas
// pantallas siguen la misma convención (ver lib/wizard-url.ts): con un solo
// chatbot —todos los clientes de hoy— no se añade nada y las URLs son las de
// siempre.
//
// A diferencia de las rutas que ESCRIBEN (que con dos chatbots y sin id se
// niegan), una pantalla sin id muestra el primero y pinta el selector
// encima: mirar el chatbot equivocado se corrige con un clic, y cada acción
// que la pantalla dispare lleva el id del que está a la vista.
// =============================================================================

export interface PortalChatbot {
  clientProductId: string;
  tier: string;
  /** Nombre del negocio (ClientSite) para el selector; si falta, "Chatbot N". */
  name: string;
}

export interface PortalChatbotSelection {
  /** Todos los chatbots activos del cliente, en orden estable de alta. */
  chatbots: PortalChatbot[];
  /** El que muestra la pantalla. Null solo si el cliente no tiene ninguno. */
  selected: PortalChatbot | null;
}

export async function resolvePortalChatbot(
  prisma: PrismaClient,
  clientId: string,
  rawClientProductId: string | null | undefined,
): Promise<PortalChatbotSelection> {
  const rows = await prisma.clientProduct.findMany({
    where: { clientId, status: 'active', product: { code: 'chatbot' } },
    select: {
      id: true,
      product: { select: { tier: true } },
      clientSite: { select: { name: true } },
    },
    // Mismo orden estable que resolveContractedInstance.
    orderBy: { subscribedAt: 'asc' },
  });
  const chatbots = rows.map((row, i) => ({
    clientProductId: row.id,
    tier: row.product.tier,
    name: row.clientSite?.name?.trim() || `Chatbot ${i + 1}`,
  }));
  const selected =
    (rawClientProductId && chatbots.find((c) => c.clientProductId === rawClientProductId)) || chatbots[0] || null;
  return { chatbots, selected };
}

/** El id que las acciones de la pantalla deben mandar: solo con varios
 *  chatbots. Con uno, null, y las llamadas quedan como siempre. */
export function chatbotParamFor(selection: PortalChatbotSelection): string | null {
  return selection.chatbots.length > 1 ? selection.selected?.clientProductId ?? null : null;
}
