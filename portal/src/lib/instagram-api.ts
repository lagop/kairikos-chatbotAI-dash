import 'server-only';
import { graphUrl } from './meta-business';
import { logError } from './observability';

// =============================================================================
// Canales — activación real de Instagram Messaging. No tiene su propio
// subscribe: una cuenta de Instagram profesional siempre está vinculada
// a una Página de Facebook, y messenger-api.ts's subscribePage ya
// suscribe esa página a los campos de mensajería que cubren ambos
// canales — ver el comentario en messenger-api.ts.
//
// UNVERIFIED AGAINST A REAL META APP.
// =============================================================================

export type InstagramApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function sendMessage(
  accessToken: string,
  igUserId: string,
  recipientId: string,
  text: string,
): Promise<InstagramApiResult<{ message_id?: string }>> {
  try {
    const url = new URL(graphUrl(`/${igUserId}/messages`));
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string }; message_id?: string } | null;
    if (!res.ok || json?.error) {
      return { ok: false, error: json?.error?.message ?? `instagram_api_http_${res.status}` };
    }
    return { ok: true, data: { message_id: json?.message_id } };
  } catch (err) {
    logError('instagram_api.send_failed', err, { route: 'lib/instagram-api.ts' }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
