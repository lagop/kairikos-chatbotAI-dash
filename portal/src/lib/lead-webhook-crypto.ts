import 'server-only';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';

// =============================================================================
// El cifrado de la URL y el secreto del webhook de leads (30/09/2026).
//
// La revisión de seguridad del 30/09 encontró las dos en claro en
// LeadWebhook. El propio esquema avisaba de que la URL es tan sensible como el
// secreto: la de Zapier, Make o n8n lleva su token dentro, y con ella
// cualquiera mete leads falsos en el CRM del cliente.
//
// Su propia clave, LEAD_WEBHOOK_ENCRYPTION_KEY, como cada clase de secreto de
// este código (CLAUDE.md: «no se reutiliza una clave para otra cosa»).
//
// SIN LA CLAVE, el webhook no se puede configurar (la ruta responde 503
// 'not_configured') y las entregas se registran como fallidas, sin romper la
// creación del lead: la misma degradación que el resto de integraciones.
// =============================================================================

export interface EncryptedParts {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

function key(): Buffer {
  return parseHexKey('LEAD_WEBHOOK_ENCRYPTION_KEY', process.env.LEAD_WEBHOOK_ENCRYPTION_KEY || undefined);
}

export function isLeadWebhookCryptoConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** Las seis columnas de LeadWebhook, a partir de la URL y el secreto. */
export function encryptLeadWebhook(url: string, secret: string) {
  const k = key();
  const u = encryptBuffer(url, k);
  const s = encryptBuffer(secret, k);
  return {
    urlCiphertext: u.ciphertext,
    urlIv: u.iv,
    urlTag: u.tag,
    secretCiphertext: s.ciphertext,
    secretIv: s.iv,
    secretTag: s.tag,
  };
}

interface EncryptedRow {
  urlCiphertext: Uint8Array | null;
  urlIv: Uint8Array | null;
  urlTag: Uint8Array | null;
  secretCiphertext: Uint8Array | null;
  secretIv: Uint8Array | null;
  secretTag: Uint8Array | null;
}

function parts(ciphertext: Uint8Array | null, iv: Uint8Array | null, tag: Uint8Array | null): EncryptedParts | null {
  if (!ciphertext || !iv || !tag) return null;
  return { ciphertext: Buffer.from(ciphertext), iv: Buffer.from(iv), tag: Buffer.from(tag) };
}

/** La URL y el secreto en claro, o null si la fila no está cifrada o la
 *  clave no está / no es la de cuando se guardó. Nunca lanza. */
export function decryptLeadWebhook(row: EncryptedRow): { url: string; secret: string } | null {
  try {
    const u = parts(row.urlCiphertext, row.urlIv, row.urlTag);
    const s = parts(row.secretCiphertext, row.secretIv, row.secretTag);
    if (!u || !s) return null;
    const k = key();
    return { url: decryptBuffer(u, k), secret: decryptBuffer(s, k) };
  } catch {
    return null;
  }
}
