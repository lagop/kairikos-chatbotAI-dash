import 'server-only';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// SEO con IA (product code 'seo'), Fase A — the client's own encryption
// helper for the WordPress Application Password on SeoProfile. Its own
// dedicated key (SEO_CMS_CREDENTIAL_ENCRYPTION_KEY) — never shared with
// any other *_ENCRYPTION_KEY, same convention as every other credential
// class in this codebase.
// =============================================================================

function getEncryptionKey(): Buffer {
  return parseHexKey('SEO_CMS_CREDENTIAL_ENCRYPTION_KEY', process.env.SEO_CMS_CREDENTIAL_ENCRYPTION_KEY);
}

export interface EncryptedWordPressAppPassword {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptWordPressAppPassword(plaintext: string): EncryptedWordPressAppPassword {
  return encryptBuffer(plaintext, getEncryptionKey());
}

export function decryptWordPressAppPassword(parts: EncryptedWordPressAppPassword): string {
  return decryptBuffer(parts, getEncryptionKey());
}
