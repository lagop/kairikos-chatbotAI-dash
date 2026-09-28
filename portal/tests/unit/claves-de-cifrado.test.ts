// =============================================================================
// El panel de claves de cifrado (/admin/portal/settings/security) y la
// comprobación de formato. Que la lista esté completa y cableada lo comprueba
// deploy-env-wiring.test.ts.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));

import { CLAVES_DE_CIFRADO, estadoDeClave } from '@/lib/claves-de-cifrado';
import { EncryptionKeyStatusTable } from '@/components/portal/EncryptionKeyStatusTable';

const HEX_64 = 'a'.repeat(64);

describe('estadoDeClave', () => {
  it('64 caracteres hexadecimales: configurada (lo que exige parseHexKey)', () => {
    expect(estadoDeClave(HEX_64)).toBe('configurada');
    expect(estadoDeClave('0123456789ABCDEFabcdef'.padEnd(64, '0'))).toBe('configurada');
  });

  // docker-compose.yml declara todas las variables: una que no llega vale ''.
  it.each([undefined, ''])('%j cuenta como ausente', (valor) => {
    expect(estadoDeClave(valor)).toBe('falta');
  });

  it.each([
    ['corta', 'a'.repeat(32)],
    ['base64 en vez de hex', 'q'.repeat(64)],
    ['con espacios alrededor', ` ${HEX_64} `],
  ])('formato inválido: %s', (_, valor) => {
    expect(estadoDeClave(valor)).toBe('formato_invalido');
  });
});

describe('EncryptionKeyStatusTable', () => {
  const originales = Object.fromEntries(CLAVES_DE_CIFRADO.map((c) => [c.nombre, process.env[c.nombre]]));
  afterEach(() => {
    for (const [k, v] of Object.entries(originales)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('enseña el estado de cada clave, y nunca su valor', () => {
    for (const c of CLAVES_DE_CIFRADO) process.env[c.nombre] = HEX_64;
    process.env.GOOGLE_SEO_TOKEN_ENCRYPTION_KEY = '';
    process.env.GOOGLE_GA4_TOKEN_ENCRYPTION_KEY = 'no-es-hex';

    const html = renderToStaticMarkup(createElement(EncryptionKeyStatusTable));

    expect(html.match(/data-testid="encryption-key-[A-Z0-9_]+-status"/g)).toHaveLength(CLAVES_DE_CIFRADO.length);
    expect(html).toMatch(/GOOGLE_SEO_TOKEN_ENCRYPTION_KEY-status"[^>]*>Falta</);
    expect(html).toMatch(/GOOGLE_GA4_TOKEN_ENCRYPTION_KEY-status"[^>]*>Formato inválido</);
    expect(html).toMatch(/ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY-status"[^>]*>Configurada</);
    expect(html).not.toContain(HEX_64);
    expect(html).not.toContain('no-es-hex');
  });
});
