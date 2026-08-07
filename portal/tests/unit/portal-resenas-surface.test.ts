// =============================================================================
// KAIA-11956 — regression test for the portal chrome around `/portal/resenas`.
//
// Bug: the `/portal/resenas` route existed as a "Próximamente" placeholder,
// but `PortalHeader` did not link to it from the top nav (desktop or mobile),
// and the home `/portal` summary also had no entry pointing there. Customers
// reported "Google Reviews section missing from the portal" because no
// discoverable chrome linked to the placeholder.
//
// This test pins the fix at the source level (without needing a React render
// pipeline) so vitest does not need a JSX transform:
//   - `PortalHeader` must list `/portal/resenas` in its `NAV` array with the
//     visible label "Reseñas" so both the desktop and the mobile nav render
//     a discoverable link.
//   - The "Pronto" badge string must accompany that nav entry so customers
//     land on a clear "coming soon" state rather than a silently missing
//     section.
//   - The home page `/portal/page.tsx` must include a section that points at
//     `/portal/resenas`, so the customer also sees Reseñas from the Resumen
//     card grid.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORTAL_HEADER = resolve(
  __dirname,
  '../../src/components/portal/PortalHeader.tsx'
);
const PORTAL_HOME = resolve(__dirname, '../../src/app/portal/page.tsx');
const RESENAS_PAGE = resolve(
  __dirname,
  '../../src/app/portal/resenas/page.tsx'
);

const headerSrc = readFileSync(PORTAL_HEADER, 'utf8');
const homeSrc = readFileSync(PORTAL_HOME, 'utf8');
const resenasSrc = readFileSync(RESENAS_PAGE, 'utf8');

describe('Portal chrome — Reseñas surface (KAIA-11956)', () => {
  it('PortalHeader lists /portal/resenas in the top nav with a Pronto badge', () => {
    expect(headerSrc).toMatch(
      /\{[^}]*href:\s*'\/portal\/resenas'[^}]*label:\s*'Reseñas'[^}]*badge:\s*'Pronto'[^}]*\}/
    );
  });

  it('PortalHeader nav links carry header-nav-* data-testid for QA', () => {
    // The desktop nav maps NAV items to <Link data-testid={`header-nav-${item.href...`}>
    expect(headerSrc).toContain('header-nav-${item.href.replace(/\\//g, \'-\')}');
  });

  it('PortalHome renders a card pointing at /portal/resenas', () => {
    expect(homeSrc).toContain('href="/portal/resenas"');
    expect(homeSrc).toContain('Reseñas de Google');
    expect(homeSrc).toContain('data-testid="resenas-summary-card"');
  });

  it('/portal/resenas still renders a clear Próximamente placeholder', () => {
    expect(resenasSrc).toContain("title: 'Reseñas · Próximamente'");
    expect(resenasSrc).toContain('Gestiona las reseñas de Google de tu negocio');
  });

  it('previously-shipped nav items are preserved', () => {
    for (const href of [
      '/portal',
      '/portal/onboarding',
      '/portal/status',
      '/portal/conversations',
      '/portal/billing',
      '/portal/support',
    ]) {
      expect(
        headerSrc,
        `expected PortalHeader NAV entry for ${href}`
      ).toContain(`href: '${href}'`);
    }
  });
});