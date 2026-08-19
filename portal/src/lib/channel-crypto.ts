import 'server-only';
import { encryptBuffer, decryptBuffer, parseHexKey, type EncryptedBuffer } from './operator-crypto';

// =============================================================================
// WP: conexión de canales — encryption for channel connection credentials
// (Telegram bot tokens, Meta access tokens). Same generic primitives as
// GoogleBusinessConnection's refresh token (operator-crypto.ts's
// encryptBuffer/decryptBuffer), own dedicated key
// (CHANNEL_CREDENTIAL_ENCRYPTION_KEY) — different secret classes should
// never share key material (see operator-crypto.ts's own comment on
// this). Telegram and Meta share ONE key, not one each: both are the
// same class of secret ("chat channel credential"), unlike e.g. Stripe
// keys vs Google OAuth tokens which are genuinely different classes.
//
// ChatWebEmbed's publicToken is deliberately NOT encrypted here — it's
// a public identifier meant to be pasted into a client's HTML, not a
// secret.
// =============================================================================

function getChannelEncryptionKey(): Buffer {
  return parseHexKey('CHANNEL_CREDENTIAL_ENCRYPTION_KEY', process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY);
}

export function encryptChannelCredential(plaintext: string): EncryptedBuffer {
  return encryptBuffer(plaintext, getChannelEncryptionKey());
}

export function decryptChannelCredential(parts: EncryptedBuffer): string {
  return decryptBuffer(parts, getChannelEncryptionKey());
}
