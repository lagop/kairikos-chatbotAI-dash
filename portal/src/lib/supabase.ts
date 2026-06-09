import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const PORTAL_API_BASE_URL = process.env.PORTAL_API_BASE_URL ?? '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const isBackendConfigured = Boolean(PORTAL_API_BASE_URL);

export async function createSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(SUPABASE_URL || 'https://invalid.supabase.co', SUPABASE_ANON_KEY || 'invalid', {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // noop in server components; route handlers can still set
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // noop
        }
      },
    },
  });
}
