// Captures the KAIA-1062 self-service UI on /portal/onboarding and
// /portal/dashboard in mobile (390x844) and desktop (1280x800) viewports.
//
// Output: /paperclip/instances/default/workspaces/3a88bddc-176e-4668-bbf5-a40f0aca7788/kaia1062-screenshots/
//
// Usage:
//   PORTAL_URL=http://localhost:3001 node scripts/capture-kaia1062.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:3001';
const OUT_DIR = '/paperclip/instances/default/workspaces/3a88bddc-176e-4668-bbf5-a40f0aca7788/kaia1062-screenshots';

const SHOTS = [
  { path: '/portal/onboarding', name: 'onboarding-with-actions' },
  { path: '/portal/dashboard', name: 'dashboard-with-help' },
  { path: '/portal/onboarding', name: 'onboarding-help-form-open', openHelp: true },
];

const VIEWPORTS = [
  { tag: 'mobile', width: 390, height: 844 },
  { tag: 'desktop', width: 1280, height: 800 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    for (const shot of SHOTS) {
      await page.goto(`${PORTAL_URL}${shot.path}`, { waitUntil: 'networkidle' });
      if (shot.openHelp) {
        const help = page.getByTestId('self-service-help');
        await help.click().catch(() => null);
        await page.waitForTimeout(150);
      }
      const file = path.join(OUT_DIR, `${shot.name}-${vp.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`captured ${file}`);
    }
    await context.close();
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
