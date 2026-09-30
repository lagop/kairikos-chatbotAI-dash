import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Revocar las sesiones de un cliente (revisión de seguridad del 30/09/2026).
//
// Las sesiones de cliente son JWT de NextAuth: no hay fila que borrar. Lo que
// sí hay es User.sessionVersion, que el token lleva desde que se emitió y que
// el callback jwt de auth.ts compara en cada petición. Subirla invalida TODOS
// los tokens emitidos antes, en todos los dispositivos.
//
// Por eso cerrar sesión en un sitio la cierra en todos. Es a propósito: la
// alternativa —revocar solo ese token— exige una lista de tokens revocados
// con su caducidad, y el caso que importa (alguien con una cookie robada) se
// resuelve igual de bien así. Si algún cliente lo echa de menos, es el
// momento de hacer la lista.
// =============================================================================

export async function revokeClientSessions(prisma: PrismaClient, email: string): Promise<void> {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return;
  await prisma.user.updateMany({
    where: { email: normalized, role: 'client' },
    data: { sessionVersion: { increment: 1 } },
  });
}
