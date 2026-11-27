// =============================================================================
// lib/web-widget-snippet.ts — el snippet de /portal/canales carga el widget v2,
// el que pide el consentimiento en su formulario de contacto, y ese archivo
// existe y lo tiene.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildWidgetSnippet, WIDGET_SCRIPT_PATH } from '@/lib/web-widget-snippet';

describe('buildWidgetSnippet', () => {
  it('carga embed.v2.js del portal con el token del cliente', () => {
    expect(buildWidgetSnippet('https://portal.example', 'wgt_abc')).toBe(
      '<script src="https://portal.example/widget/embed.v2.js" data-space-token="wgt_abc" async></script>',
    );
  });

  it('no vuelve al v1, que no tiene casilla de consentimiento', () => {
    expect(buildWidgetSnippet('', 'wgt_abc')).not.toContain('/widget/embed.js"');
  });

  it('apunta a un archivo que existe y que guarda el consentimiento del formulario', () => {
    const file = join(process.cwd(), 'public', WIDGET_SCRIPT_PATH);
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('data-space-token');
    expect(source).toContain('noticeVersion');
  });
});
