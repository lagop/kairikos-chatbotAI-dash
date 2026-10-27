import { describe, expect, it } from 'vitest';

// La vista previa de plantillas se mide dentro de un marco del laboratorio;
// todo lo demás sigue sin dejarse enmarcar. Ver next.config.js.

const nextConfig = require('../../next.config.js') as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };

describe('cabeceras de next.config.js', () => {
  it('solo la vista previa de plantillas admite un marco del propio portal, y su regla va después de la general', async () => {
    const rules = await nextConfig.headers();
    const csp = (source: string) => rules.findIndex((r) => r.source === source && r.headers.some((h) => h.key === 'Content-Security-Policy'));
    const general = csp('/:path*');
    const preview = csp('/api/admin/portal/site-templates/:templateId/preview');
    expect(rules[general].headers.find((h) => h.key === 'Content-Security-Policy')?.value).toMatch(/frame-ancestors 'none'/);
    expect(rules[preview].headers.find((h) => h.key === 'Content-Security-Policy')?.value).toMatch(/frame-ancestors 'self'/);
    expect(preview).toBeGreaterThan(general);
  });
});
