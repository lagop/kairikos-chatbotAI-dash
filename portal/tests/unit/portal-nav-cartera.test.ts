import { describe, expect, it } from 'vitest';
import { PORTAL_CARTERA_ITEM, PORTAL_NAV, PORTAL_VILLAS_ITEM, portalNavFor } from '@/lib/portal-nav';

// La cartera inmobiliaria, como villas, solo sale a quien la tiene contratada,
// y va debajo de «Web» (docs/fase1-cartera.md, «Producto y acceso»).

describe('portalNavFor con la cartera', () => {
  it('sin cartera, el menú común sin la entrada', () => {
    expect(portalNavFor({ cartera: false })).toBe(PORTAL_NAV);
    expect(PORTAL_NAV.some((item) => item.href === '/portal/cartera')).toBe(false);
  });

  it('con cartera, la entrada justo debajo de «Web» y nada más cambia', () => {
    const nav = portalNavFor({ cartera: true });
    const hrefs = nav.map((item) => item.href);
    expect(hrefs.indexOf('/portal/cartera')).toBe(hrefs.indexOf('/portal/web') + 1);
    expect(nav.find((item) => item.href === '/portal/cartera')).toEqual(PORTAL_CARTERA_ITEM);
    expect(nav.filter((item) => item.href !== '/portal/cartera')).toEqual([...PORTAL_NAV]);
  });

  it('con villas y cartera: Web, villas, cartera', () => {
    const hrefs = portalNavFor({ villas: true, cartera: true }).map((item) => item.href);
    const web = hrefs.indexOf('/portal/web');
    expect(hrefs.slice(web, web + 3)).toEqual(['/portal/web', PORTAL_VILLAS_ITEM.href, '/portal/cartera']);
    expect(hrefs).toHaveLength(PORTAL_NAV.length + 2);
  });

  it('la entrada es de primer nivel', () => {
    expect(PORTAL_CARTERA_ITEM.parentHref).toBeUndefined();
  });
});
