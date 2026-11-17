import { describe, expect, it } from 'vitest';
import { PORTAL_NAV, PORTAL_VILLAS_ITEM, portalNavFor } from '@/lib/portal-nav';

// La reserva de villas es la única entrada del menú que depende de lo que el
// cliente tiene contratado. Nació sin entrada ninguna y el dueño solo llegaba
// a /portal/villas por el botón de un correo; estos tests fijan las dos mitades
// del arreglo: quien la tiene la ve, y el resto sigue con el menú de siempre.

describe('portalNavFor', () => {
  it('sin villas devuelve el menú común, sin la entrada', () => {
    expect(portalNavFor()).toBe(PORTAL_NAV);
    expect(portalNavFor({ villas: false })).toBe(PORTAL_NAV);
    expect(PORTAL_NAV.some((item) => item.href === '/portal/villas')).toBe(false);
  });

  it('con villas añade la entrada justo debajo de «Web»', () => {
    const nav = portalNavFor({ villas: true });
    const hrefs = nav.map((item) => item.href);
    expect(hrefs.indexOf('/portal/villas')).toBe(hrefs.indexOf('/portal/web') + 1);
    expect(nav).toHaveLength(PORTAL_NAV.length + 1);
    expect(nav.find((item) => item.href === '/portal/villas')).toEqual(PORTAL_VILLAS_ITEM);
  });

  it('no cambia el resto del menú ni su orden', () => {
    const nav = portalNavFor({ villas: true });
    expect(nav.filter((item) => item.href !== '/portal/villas')).toEqual([...PORTAL_NAV]);
  });

  it('la entrada es de primer nivel: no cuelga de otro producto', () => {
    expect(PORTAL_VILLAS_ITEM.parentHref).toBeUndefined();
  });
});
