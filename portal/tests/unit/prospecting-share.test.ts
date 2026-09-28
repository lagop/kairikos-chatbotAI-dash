// =============================================================================
// A1 / A11 — enlaces públicos del informe y del borrador.
//
// El fallo que los trajo: las dos páginas se diseñaron para mandárselas al
// prospecto por WhatsApp y las dos exigían sesión de operador. El prospecto
// no tiene sesión, así que el único uso real devolvía {"error":"unauthorized"}.
//
// Lo que se fija aquí: que el testigo sea imposible de adivinar y que la
// validación de forma rechace basura ANTES de tocar la base de datos — una
// ruta pública es también la puerta por la que entra cualquier rastreador.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  createShareToken,
  isShareToken,
  webDraftShareUrl,
  reportShareUrl,
} from '@/lib/prospecting-share';

describe('createShareToken', () => {
  it('son 32 bytes en hexadecimal', () => {
    const token = createShareToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no se repite', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createShareToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('isShareToken', () => {
  it('acepta un testigo real', () => {
    expect(isShareToken(createShareToken())).toBe(true);
  });

  it('rechaza lo que no tiene su forma, sin consultar nada', () => {
    expect(isShareToken('')).toBe(false);
    expect(isShareToken('abc')).toBe(false);
    expect(isShareToken('../../etc/passwd')).toBe(false);
    expect(isShareToken('A'.repeat(64))).toBe(false); // mayúsculas: hex en minúscula
    expect(isShareToken('0'.repeat(63))).toBe(false);
    expect(isShareToken('0'.repeat(65))).toBe(false);
    expect(isShareToken("' OR 1=1 --")).toBe(false);
  });
});

describe('URLs públicas', () => {
  const token = 'a'.repeat(64);

  it('cuelgan del origen de la petición, sin variable de entorno nueva', () => {
    expect(webDraftShareUrl('https://portal.kairikos.cloud', token)).toBe(
      `https://portal.kairikos.cloud/borrador/${token}`,
    );
    expect(reportShareUrl('http://localhost:3000', token)).toBe(`http://localhost:3000/informe/${token}`);
  });

  it('no cuelgan de /api/admin, que es lo que pedía sesión', () => {
    expect(webDraftShareUrl('https://x.test', token)).not.toContain('/admin');
    expect(reportShareUrl('https://x.test', token)).not.toContain('/admin');
  });
});
