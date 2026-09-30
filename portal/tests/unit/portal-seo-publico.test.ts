// =============================================================================
// Lo que el portal enseña a los buscadores (30/09/2026): robots.txt y
// sitemap.xml devolvían 404, y la calculadora —un gancho enlazado desde
// kairikos.com— llevaba el noindex del layout raíz.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { metadata as calculadora } from '@/app/calculadora/page';
import { metadata as empezar } from '@/app/empezar/layout';

const original = process.env.NEXT_PUBLIC_PORTAL_URL;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_PORTAL_URL;
  else process.env.NEXT_PUBLIC_PORTAL_URL = original;
});

function reglaUnica() {
  const r = robots();
  return Array.isArray(r.rules) ? r.rules[0] : r.rules;
}

describe('portalBaseUrl', () => {
  it('una variable declarada y vacía cuenta como ausente', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = '  ';
    expect(portalBaseUrl()).toBe('https://portal.kairikos.cloud');
  });

  it('sin barra final', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.cloud/';
    expect(portalBaseUrl()).toBe('https://portal.kairikos.cloud');
  });
});

describe('robots.txt', () => {
  it('cierra la API, el panel y el portal de cliente, y apunta al sitemap', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.cloud';
    expect(reglaUnica().disallow).toEqual(['/api/', '/admin/', '/portal/']);
    expect(robots().sitemap).toBe('https://portal.kairikos.cloud/sitemap.xml');
  });

  it('NO cierra /sitios/: son las webs de los clientes y tienen que indexarse', () => {
    expect(JSON.stringify(reglaUnica().disallow)).not.toContain('sitios');
  });
});

describe('sitemap y metadatos', () => {
  it('el sitemap lleva la calculadora', () => {
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.cloud';
    expect(sitemap().map((e) => e.url)).toEqual(['https://portal.kairikos.cloud/calculadora']);
  });

  it('la calculadora se indexa; el alta no, pero sus enlaces se siguen', () => {
    expect(calculadora.robots).toEqual({ index: true, follow: true });
    expect(empezar.robots).toEqual({ index: false, follow: true });
  });
});
