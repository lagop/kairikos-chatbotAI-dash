'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { signOut } from '../../../../auth';

// KAIA-3921 — server-action logout. NextAuth v5 exposes signOut()
// which clears the JWT cookie + invalidates the session server-side.
// We additionally clear the dev-mock cookies seeded by the middleware
// so a logged-out user hitting back-navigation doesn't see a stale
// session. The `redirect` call terminates the response — the function
// never reaches a return after it.
export async function logoutAction() {
  const cookieJar = cookies();
  cookieJar.delete('kairikos-portal-dev-session');
  cookieJar.delete('kairikos-portal-dev-email');
  cookieJar.delete('kairikos-portal-operator');
  cookieJar.delete('kairikos-portal-session');

  await signOut({ redirect: false });

  redirect('/portal/login?reason=logout');
}
