// =============================================================================
// WP-14 — unit tests for src/lib/client-product-lifecycle.ts.
//
// mirrorChatbotStateToClientProduct() is the shared helper every
// ChatbotClient.state writer (other than wizard-review.ts, which writes in
// the opposite direction) calls to keep ClientProduct.onboardingState for
// the chatbot product in sync. Pure function over a `tx`-shaped object —
// no module mocking needed.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { mirrorChatbotStateToClientProduct } from '@/lib/client-product-lifecycle';

function makeTx(clientProduct: { id: string } | null) {
  return {
    clientProduct: {
      findFirst: vi.fn().mockResolvedValue(clientProduct),
      update: vi.fn().mockResolvedValue({ id: clientProduct?.id }),
    },
  } as never;
}

describe('mirrorChatbotStateToClientProduct', () => {
  it('writes onboardingState to the chatbot ClientProduct row when one exists', async () => {
    const tx = makeTx({ id: 'cp1' });
    await mirrorChatbotStateToClientProduct(tx, 'c1', 'live');

    expect(tx.clientProduct.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'c1', product: { code: 'chatbot' } },
      orderBy: { changedAt: 'desc' },
      select: { id: true },
    });
    expect(tx.clientProduct.update).toHaveBeenCalledWith({
      where: { id: 'cp1' },
      data: { onboardingState: 'live' },
    });
  });

  it('includes goLiveAt in the write only when explicitly passed', async () => {
    const tx = makeTx({ id: 'cp1' });
    const goLiveAt = new Date('2026-08-13T10:00:00.000Z');
    await mirrorChatbotStateToClientProduct(tx, 'c1', 'live', goLiveAt);

    expect(tx.clientProduct.update).toHaveBeenCalledWith({
      where: { id: 'cp1' },
      data: { onboardingState: 'live', goLiveAt },
    });
  });

  it('passes goLiveAt: null through when explicitly clearing it', async () => {
    const tx = makeTx({ id: 'cp1' });
    await mirrorChatbotStateToClientProduct(tx, 'c1', 'in-progress', null);

    expect(tx.clientProduct.update).toHaveBeenCalledWith({
      where: { id: 'cp1' },
      data: { onboardingState: 'in-progress', goLiveAt: null },
    });
  });

  it('is a no-op when the client has no ClientProduct row for chatbot (data drift)', async () => {
    const tx = makeTx(null);
    await mirrorChatbotStateToClientProduct(tx, 'c1', 'live');

    expect(tx.clientProduct.findFirst).toHaveBeenCalled();
    expect(tx.clientProduct.update).not.toHaveBeenCalled();
  });
});
