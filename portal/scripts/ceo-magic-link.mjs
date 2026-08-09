// scripts/ceo-magic-link.ts
// Generate a Supabase magic-link action URL for the CEO to log into the staging portal.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from portal/.env (or .env).
// Usage: tsx scripts/ceo-magic-link.ts <email> [portalUrl]

import { createClient } from '@supabase/supabase-js';

const email = process.argv[2] ?? 'operator@kairikos.dev';
const portalUrl = process.argv[3] ?? 'https://project-fxidg.vercel.app';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email,
  options: { redirectTo: `${portalUrl}/api/auth/callback` },
});
if (error) {
  console.error('generateLink failed:', error.message);
  process.exit(2);
}
const link = data?.properties?.action_link;
if (!link) {
  console.error('No action_link returned');
  process.exit(3);
}

console.log('EMAIL=' + email);
console.log('PORTAL=' + portalUrl);
console.log('LINK=' + link);
console.log('EXPIRES=1h default per Supabase');
