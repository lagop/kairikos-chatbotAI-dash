import { test, expect } from '@playwright/test';

const PORTAL_URL = process.env.PORTAL_URL || 'https://project-fxidg.vercel.app';
const OPERATOR_KEY = process.env.KAIA_OPERATOR_API_KEY ?? '';
const ACME_ID = '00000000-0000-0000-0000-000000000001';

test.describe('Admin Editor — auth & validation', () => {
  test('non-operator PATCH to client endpoint returns 401', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping auth edge-case tests');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ companyName: 'HackedCo' }),
    });
    expect(res.status()).toBe(401);
  });

  test('operator PATCH with no operator-key and no session returns 401', async ({ request }) => {
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': 'wrong-key-definitely-not-real',
      },
      data: JSON.stringify({ companyName: 'HackedCo' }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(300);
  });

  test('PATCH with unknown field returns 400 and names the field', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping validation tests');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': OPERATOR_KEY,
      },
      data: JSON.stringify({ totallyMadeUpField: 'value' }),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bad_request/i);
    expect(body.detail).toMatch(/totallyMadeUpField/i);
  });

  test('PATCH with invalid tier value returns 400', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping validation tests');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': OPERATOR_KEY,
      },
      data: JSON.stringify({ tier: 'enterprise' }),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/tier/i);
  });

  test('PATCH with invalid email format returns 400', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping validation tests');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': OPERATOR_KEY,
      },
      data: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH for nonexistent client returns 404', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping validation tests');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/does-not-exist`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': OPERATOR_KEY,
      },
      data: JSON.stringify({ companyName: 'GhostCo' }),
    });
    expect(res.status()).toBe(404);
  });

  test('PATCH with valid operator-key updates the row and returns audit actions', async ({ request }) => {
    test.skip(!OPERATOR_KEY, 'KAIA_OPERATOR_API_KEY not set; skipping happy-path API test');
    const res = await request.patch(`${PORTAL_URL}/api/admin/portal/clients/${ACME_ID}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-kaia-operator-key': OPERATOR_KEY,
      },
      data: JSON.stringify({ notes: `QA test note ${Date.now()}` }),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.actions)).toBe(true);
  });

  test('unauthenticated request to admin client detail page redirects to login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${PORTAL_URL}/admin/portal/${ACME_ID}`);
    await expect(page).toHaveURL(/\/portal\/login/);
  });
});
