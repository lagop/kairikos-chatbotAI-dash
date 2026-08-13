'use server';

// =============================================================================
// WP-11 — operator actions for the support-request inbox.
//
// Mirrors the pattern in [clientId]/onboarding-actions.ts: a 'use server'
// form-action handler is the auth check (gated on session.isOperator), no
// separate HTTP endpoint. Idempotent in both directions — resolving an
// already-resolved request or reopening an already-open one is a no-op
// write, not an error.
// =============================================================================

import { revalidatePath } from 'next/cache';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { setSupportRequestStatus } from '@/lib/support-requests';

export async function setSupportRequestStatusAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');

  if (typeof id !== 'string' || !id) return;
  if (status !== 'open' && status !== 'resolved') return;

  const session = await getSession();
  if (!session.isOperator) return;
  if (!isDatabaseConfigured) return;

  await setSupportRequestStatus(prisma, id, status, session.email ?? 'operador');

  revalidatePath('/admin/portal/support');
}
