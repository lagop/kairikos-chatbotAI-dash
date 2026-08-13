import type { Prisma } from '@prisma/client';
import { CHATBOT_PRODUCT_CODE } from './wizard-catalog';

// =============================================================================
// WP-14 — shared mirror-write helper for ChatbotClient.state writers.
//
// ClientProduct.onboardingState is now the source of truth for per-product
// onboarding lifecycle (see the WP-14 migration's comments on that column).
// ChatbotClient.state is kept as a COMPAT mirror of the chatbot product's
// onboardingState — n8n still listens for its 'ready' transition to fire
// config_complete, and this column predates the multi-product model.
//
// wizard-review.ts writes in the OTHER direction (ClientProduct is primary,
// ChatbotClient.state mirrors it — see maybeTransitionToReady/Updating
// there) because it already reasons in terms of a productCode. Every other
// writer only knows about the legacy ChatbotClient.state column, so this
// helper mirrors THAT write onto ClientProduct.onboardingState for the
// chatbot product. Call it in the SAME transaction as the ChatbotClient.state
// write, immediately after it, so the two columns never observably diverge.
// =============================================================================

/**
 * Mirror a ChatbotClient.state write onto ClientProduct.onboardingState for
 * the chatbot product. Best-effort / non-throwing: if the client has no
 * ClientProduct row for 'chatbot' yet (data drift — a pre-existing client,
 * or a race with the intake route's own row creation), this silently
 * no-ops rather than failing the whole request. The next wizard-review
 * transition (or a backfill) reconciles it once the row exists.
 *
 * `goLiveAt` is optional — pass a Date/null only when the caller is also
 * setting ChatbotClient.goLiveAt in the same write (null clears it);
 * omitting the argument entirely leaves ClientProduct.goLiveAt untouched.
 */
export async function mirrorChatbotStateToClientProduct(
  tx: Prisma.TransactionClient,
  clientId: string,
  state: string,
  goLiveAt?: Date | null,
): Promise<void> {
  const clientProduct = await tx.clientProduct.findFirst({
    where: { clientId, product: { code: CHATBOT_PRODUCT_CODE } },
    orderBy: { changedAt: 'desc' },
    select: { id: true },
  });
  if (!clientProduct) return;
  await tx.clientProduct.update({
    where: { id: clientProduct.id },
    data: {
      onboardingState: state,
      ...(goLiveAt !== undefined ? { goLiveAt } : {}),
    },
  });
}
