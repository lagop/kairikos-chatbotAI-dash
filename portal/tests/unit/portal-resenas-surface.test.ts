// =============================================================================
// KAIA-11956 — regression test for the portal chrome around `/portal/resenas`.
//
// Bug: the `/portal/resenas` route existed as a "Próximamente" placeholder,
// but `PortalHeader` did not link to it from the top nav (desktop or mobile),
// and the home `/portal` summary also had no entry pointing there. Customers
// reported "Google Reviews section missing from the portal" because no
// discoverable chrome linked to the placeholder.
//
// Follow-up (board user feedback): the "Pronto" badge was misleading because
// the Reseñas service is genuinely not available to customers today. The
// section must NOT promise "coming soon" — it must render an honest
// "not available on your plan" state. This test pins:
//   - `PortalHeader` NAV must include `/portal/resenas` with the label
//     "Reseñas" so both desktop and mobile navs are discoverable, but
//     WITHOUT a "Pronto" badge.
//   - The home page `/portal/page.tsx` must include a section that points
//     at `/portal/resenas` and renders an honest "No incluido" pill
//     instead of a "Pronto" promise.
//   - `/portal/resenas` must render a clear "Función no disponible" state
//     that links the customer to `/portal/support`, NOT a placeholder
//     that promises the feature is coming.
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
  it('PortalHeader lists /portal/resenas in the top nav without a "Pronto" badge', () => {
    expect(headerSrc).toMatch(
      /\{[^}]*href:\s*'\/portal\/resenas'[^}]*label:\s*'Reseñas'[^}]*\}/
    );
    // The NAV entry must not promise the feature is coming soon.
    expect(headerSrc).not.toMatch(/href:\s*'\/portal\/resenas'[\s\S]*?badge:\s*'Pronto'/);
  });

  it('PortalHeader nav links carry header-nav-* data-testid for QA', () => {
    expect(headerSrc).toContain(
      "header-nav-${item.href.replace(/\\//g, '-')}"
    );
  });

  it('PortalHome renders a card pointing at /portal/resenas with an honest "No incluido" pill', () => {
    expect(homeSrc).toContain('href="/portal/resenas"');
    expect(homeSrc).toContain('Reseñas de Google');
    expect(homeSrc).toContain('data-testid="resenas-summary-card"');
    expect(homeSrc).toContain('>No incluido<');
    // The home card must not promise "Pronto".
    expect(homeSrc).not.toMatch(/resenas-summary[\s\S]{0,200}>Pronto</);
  });

  it('/portal/resenas renders a clear "not available" state pointing the customer to support', () => {
    expect(resenasSrc).toContain(
      "title: 'Reseñas · No disponible en tu plan'"
    );
    expect(resenasSrc).toContain('Función no disponible');
    expect(resenasSrc).toContain('href="/portal/support"');
    expect(resenasSrc).toContain('data-testid="resenas-contact-support"');
    expect(resenasSrc).toContain('data-testid="resenas-back-to-dashboard"');
    // The page must not promise the feature is coming soon.
    expect(resenasSrc).not.toContain('Próximamente');
    expect(resenasSrc).not.toContain('Pronto');
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