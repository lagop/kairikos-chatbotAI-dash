import 'server-only';
import { decryptWordPressAppPassword, type EncryptedWordPressAppPassword } from './seo';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase C — the final publish step. WordPress via REST API is
// the v1 (and only) publish target — see SeoContentDraft's own schema
// comment and the PR that added it for why: SeoProfile already carries
// wordpressUrl/wordpressUsername/wordpressAppPassword from the Fase A
// operator technical setup, cabled explicitly for this. No generic
// multi-CMS publisher is built — there is exactly one real target.
//
// Auth: HTTP Basic (RFC 7617) — `Authorization: Basic
// base64(username:applicationPassword)` — WordPress's own Application
// Passwords feature, not a real user password. Endpoint/field names
// verified against WordPress's own REST API reference
// (developer.wordpress.org/rest-api/reference/posts/#create-a-post,
// fetched Sep 2026): POST /wp-json/wp/v2/posts with
// {title, content, status, excerpt}; response has {id, link}.
//
// UNVERIFIED AGAINST A REAL WORDPRESS SITE — same standing caveat as
// every external integration built this session with no reachable real
// credentials in this environment.
// =============================================================================

interface WordPressCredentials {
  wordpressUrl: string;
  wordpressUsername: string;
  wordpressAppPasswordCiphertext: Buffer;
  wordpressAppPasswordIv: Buffer;
  wordpressAppPasswordTag: Buffer;
}

interface DraftToPublish {
  title: string;
  bodyHtml: string;
  metaDescription: string | null;
}

export type PublishResult =
  | { ok: true; postId: string; postUrl: string }
  | { ok: false; error: string };

/** True only when every field the operator's technical setup fills in
 *  (Fase A) is actually present — publishing is gated on this, content
 *  generation/approval is not (see seo-content-generation.ts's own
 *  comment on why drafting doesn't require WordPress creds). */
type NullablePartial<T> = { [K in keyof T]?: T[K] | null };

export function hasWordPressCredentials(
  profile: NullablePartial<WordPressCredentials> | null | undefined,
): profile is WordPressCredentials {
  return Boolean(
    profile?.wordpressUrl &&
      profile.wordpressUsername &&
      profile.wordpressAppPasswordCiphertext &&
      profile.wordpressAppPasswordIv &&
      profile.wordpressAppPasswordTag,
  );
}

function buildPostsUrl(wordpressUrl: string): string {
  return `${wordpressUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
}

export async function publishDraftToWordPress(
  profile: WordPressCredentials,
  draft: DraftToPublish,
): Promise<PublishResult> {
  let appPassword: string;
  try {
    appPassword = decryptWordPressAppPassword({
      ciphertext: profile.wordpressAppPasswordCiphertext,
      iv: profile.wordpressAppPasswordIv,
      tag: profile.wordpressAppPasswordTag,
    } satisfies EncryptedWordPressAppPassword);
  } catch (err) {
    logError('wordpress_publish.decrypt_failed', err, { url: buildPostsUrl(profile.wordpressUrl) });
    return { ok: false, error: 'credential_decrypt_failed' };
  }

  const basicAuth = Buffer.from(`${profile.wordpressUsername}:${appPassword}`).toString('base64');

  try {
    const res = await fetch(buildPostsUrl(profile.wordpressUrl), {
      method: 'POST',
      headers: { authorization: `Basic ${basicAuth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        content: draft.bodyHtml,
        status: 'publish',
        ...(draft.metaDescription ? { excerpt: draft.metaDescription } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `wordpress_error:${res.status}:${body.slice(0, 300)}` };
    }
    const json = (await res.json()) as { id?: number; link?: string };
    if (!json.id || !json.link) {
      return { ok: false, error: 'unexpected_response_shape' };
    }
    return { ok: true, postId: String(json.id), postUrl: json.link };
  } catch (err) {
    logError('wordpress_publish.request_failed', err, { url: buildPostsUrl(profile.wordpressUrl) }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
