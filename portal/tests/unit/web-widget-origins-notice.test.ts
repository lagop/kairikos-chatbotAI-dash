// =============================================================================
// Aviso de la portada del portal (21/11/2026): «elige en qué webs funciona tu
// chat». Quién lo ve lo decide findWidgetWithoutAllowedOrigins: un widget web
// ACTIVO del cliente con la lista VACÍA. Los tests corren sin DOM, así que la
// tarjeta (WidgetOriginsNotice) se comprobó en el navegador; aquí, la consulta.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { findWidgetWithoutAllowedOrigins } from '@/lib/web-widget-origin';

function prismaWith(result: unknown) {
  const findFirst = vi.fn().mockResolvedValue(result);
  return { prisma: { chatWebEmbed: { findFirst } } as unknown as PrismaClient, findFirst };
}

describe('findWidgetWithoutAllowedOrigins', () => {
  it('busca solo widgets activos de ESE cliente con la lista vacía', async () => {
    const { prisma, findFirst } = prismaWith(null);
    await findWidgetWithoutAllowedOrigins(prisma, 'client_9');
    expect(findFirst.mock.calls[0][0].where).toEqual({
      clientId: 'client_9',
      status: 'active',
      allowedOrigins: { isEmpty: true },
    });
  });

  it('devuelve el chatbot del widget, para que el enlace lleve al correcto', async () => {
    const { prisma } = prismaWith({ clientProductId: 'cp_2' });
    expect(await findWidgetWithoutAllowedOrigins(prisma, 'client_9')).toEqual({ clientProductId: 'cp_2' });
  });

  it('sin ninguno (sin widget, apagado o ya con lista), null: no hay aviso', async () => {
    const { prisma } = prismaWith(null);
    expect(await findWidgetWithoutAllowedOrigins(prisma, 'client_9')).toBeNull();
  });

  it('con varios, siempre el mismo (el más antiguo), no uno al azar en cada visita', async () => {
    const { prisma, findFirst } = prismaWith(null);
    await findWidgetWithoutAllowedOrigins(prisma, 'client_9');
    expect(findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });
});
