import 'server-only';
import { cookies } from 'next/headers';
import { createSupabaseServerClient, isSupabaseConfigured } from './supabase';
import { prisma, isDatabaseConfigured } from './prisma';
import { MOCK_CLIENT } from './portal-data';

export interface ResolvedClient {
  clientId: string;
  email: string;
  source: 'database' | 'mock_dev' | 'header_dev';
}

const DEV_EMAIL_HEADER = 'x-kairikos-dev-email';

async function resolveFromSupabaseEmail(email: string): Promise<ResolvedClient | null> {
  if (!isDatabaseConfigured) {
    if (email.toLowerCase() === MOCK_CLIENT.primaryContactEmail.toLowerCase()) {
      return { clientId: MOCK_CLIENT.id, email, source: 'mock_dev' };
    }
    return null;
  }
  const link = await prisma.chatbotClientUser.findUnique({
    where: { nextAuthEmail: email.toLowerCase() },
    select: { clientId: true },
  });
  if (!link) return null;
  return { clientId: link.clientId, email, source: 'database' };
}

export async function resolveClientFromSession(): Promise<ResolvedClient | null> {
  if (isSupabaseConfigured) {
    const supabase = await createSupabaseServerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user?.email) return null;
    return resolveFromSupabaseEmail(session.user.email);
  }
  // Dev fallback: trust an explicit dev-email header set by Playwright / local
  // tools. If absent, fall back to the mock client so the UI is always demoable.
  const devEmail = cookies().get('kairikos-portal-dev-email')?.value;
  if (devEmail) {
    return resolveFromSupabaseEmail(devEmail);
  }
  return { clientId: MOCK_CLIENT.id, email: MOCK_CLIENT.primaryContactEmail, source: 'mock_dev' };
}

export function readDevEmailHeader(req: Request): string | null {
  return req.headers.get(DEV_EMAIL_HEADER);
}
