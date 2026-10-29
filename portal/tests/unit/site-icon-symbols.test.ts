import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateIconSymbols } from '@/lib/site-icon-symbols';
import { templateIconIds } from '@/lib/web-draft-design';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

describe('los iconos de una plantilla, para elegirlos viéndolos', () => {
  it('en cada plantilla, los mismos iconos que se ofrecen, cada uno con su dibujo', () => {
    const dir = join(process.cwd(), 'plantillas');
    const marcos = [SITE_TEMPLATE_BASE.marco, ...readdirSync(dir).map((d) => readFileSync(join(dir, d, 'marco.html'), 'utf8'))];
    for (const marco of marcos) {
      const icons = templateIconSymbols(marco);
      expect(icons.map((i) => i.id)).toEqual(templateIconIds(marco));
      for (const i of icons) expect(i.body).toMatch(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/);
    }
  });

  it('solo pasan formas y atributos de dibujo: nada que cargue o ejecute', () => {
    const marco = `<svg><symbol id="i-malo" viewBox="0 0 24 24"><script>alert(1)</script><path d="M1 1L2 2" onclick="x()" fill="url(https://evil/x)" stroke="currentColor"/><image href="https://evil/x.png"/><a href="javascript:x"><circle cx="2" cy="2" r="1" style="x"/></a><foreignObject><div>hola</div></foreignObject></symbol></svg>`;
    const [icon] = templateIconSymbols(marco);
    expect(icon.body).toBe('<path d="M1 1L2 2" stroke="currentColor"/><circle cx="2" cy="2" r="1"/>');
  });
});
