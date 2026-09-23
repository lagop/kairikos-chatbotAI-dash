import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isProductContracted } from './client-product-access';
import { summarizeReviews } from './review-reputation';

// =============================================================================
// Producto Web, Fase 1 — lo que la web publicada toma de los OTROS productos
// del cliente.
//
// Dos cosas, y las dos solo si las tiene contratadas:
//
//   reviews → sus estrellas reales de Google en la página. Quien paga por
//     cuidar su reputación quiere enseñarla, y es el dato que más convence
//     a quien duda entre dos negocios.
//   recall → el número que se pinta y al que llaman los botones. Si tiene
//     recall, el teléfono de su web TIENE que ser el número que atiende las
//     llamadas perdidas; dejar el viejo hace que el producto que compró no
//     recoja nada, y es el tipo de fallo que no da ningún error.
//
// Sin el producto contratado, ninguna de las dos aparece: la web no enseña
// datos de un producto que el cliente no paga, y tampoco se le cambia el
// teléfono por uno que no controla.
//
// Es una foto del momento de publicar. Si el cliente contrata reviews
// después, sus estrellas aparecen en la siguiente publicación, no sola: una
// web estática no se entera de nada hasta que se vuelve a subir.
// =============================================================================

export interface WebsiteIntegrations {
  /** Estrellas y número de reseñas, o null si no tiene `reviews` o aún no
   *  ha sincronizado ninguna. */
  reviews: { rating: number; count: number } | null;
  /** Número de `recall`, que sustituye al teléfono guardado del sitio. */
  recallPhone: string | null;
}

export async function resolveWebsiteIntegrations(
  prisma: PrismaClient,
  clientId: string,
  now: Date = new Date(),
): Promise<WebsiteIntegrations> {
  const [hasReviews, hasRecall] = await Promise.all([
    isProductContracted(prisma, clientId, 'reviews'),
    isProductContracted(prisma, clientId, 'recall'),
  ]);

  let reviews: WebsiteIntegrations['reviews'] = null;
  if (hasReviews) {
    const rows = await prisma.googleReview.findMany({
      where: { clientId },
      select: { starRating: true, createTime: true, replyComment: true },
    });
    const summary = summarizeReviews(rows, now);
    // Con menos de tres reseñas no se enseña nada. "4,0 sobre 5 · 1 reseña"
    // en una portada resta en vez de sumar, y es justo lo contrario de lo
    // que el cliente compró.
    if (summary.averageRating !== null && summary.totalReviews >= 3) {
      reviews = { rating: summary.averageRating, count: summary.totalReviews };
    }
  }

  let recallPhone: string | null = null;
  if (hasRecall) {
    const subscription = await prisma.recallSubscription.findFirst({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      select: { virtualNumber: { select: { e164: true } } },
    });
    recallPhone = subscription?.virtualNumber?.e164 ?? null;
  }

  return { reviews, recallPhone };
}
