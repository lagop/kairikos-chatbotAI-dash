// =============================================================================
// El texto de una plantilla vive en Meta; nosotros solo mandamos las
// variables. Si el aprobado no es el del código, el cliente recibe otra
// cosa y nada lo delata — pasó con tres plantillas que se enviaron durante
// semanas con los acentos convertidos en interrogantes.
// Ver findTemplateTextDrift en src/lib/recall-templates.ts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { findTemplateTextDrift, allRecallTemplateDefinitions } from '@/lib/recall-templates';

const DEFS = [
  { name: 'recall_owner_message', bodyText: 'Tienes un recado nuevo. Te llamó {{1}} y dijo: {{2}}. Contesta cuando puedas.' },
  { name: 'recall_daily_digest', bodyText: 'Hoy tuviste {{1}} llamadas perdidas: {{2}}.' },
];

function meta(name: string, text: string) {
  return { name, components: [{ type: 'BODY', text }] };
}

describe('findTemplateTextDrift', () => {
  it('caza el acento perdido, que es el caso real', () => {
    const drift = findTemplateTextDrift(
      [meta('recall_owner_message', 'Tienes un recado nuevo. Te llam? {{1}} y dijo: {{2}}. Contesta cuando puedas.')],
      DEFS,
    );

    expect(drift).toHaveLength(1);
    expect(drift[0].name).toBe('recall_owner_message');
    expect(drift[0].actual).toContain('llam?');
    expect(drift[0].expected).toContain('llamó');
  });

  it('no dice nada cuando el texto coincide', () => {
    expect(findTemplateTextDrift([meta('recall_owner_message', DEFS[0].bodyText)], DEFS)).toEqual([]);
  });

  it('perdona los espacios de más: busca un acento perdido, no una discusión de formato', () => {
    const conEspacios = DEFS[0].bodyText.replace('recado nuevo.', 'recado  nuevo.\n');
    expect(findTemplateTextDrift([meta('recall_owner_message', conEspacios)], DEFS)).toEqual([]);
  });

  it('ignora las plantillas que el código no define — la cuenta tiene más cosas', () => {
    expect(findTemplateTextDrift([meta('hello_world', 'Hello {{1}}')], DEFS)).toEqual([]);
  });

  it('calla cuando Meta no devuelve el cuerpo, en vez de inventar un desvío', () => {
    expect(findTemplateTextDrift([{ name: 'recall_owner_message' }], DEFS)).toEqual([]);
    expect(findTemplateTextDrift([{ name: 'recall_owner_message', components: [{ type: 'FOOTER', text: 'x' }] }], DEFS)).toEqual([]);
  });

  it('revisa varias a la vez y devuelve solo las desviadas', () => {
    const drift = findTemplateTextDrift(
      [
        meta('recall_owner_message', DEFS[0].bodyText),
        meta('recall_daily_digest', 'Hoy tuviste {{1}} llamadas perdidas: {{2}}!'),
      ],
      DEFS,
    );
    expect(drift.map((d) => d.name)).toEqual(['recall_daily_digest']);
  });

  // La lista de verdad, no una de prueba: si alguien edita un bodyText y
  // se deja un {{n}} por el camino, esto no lo caza, pero al menos
  // garantiza que la función se puede llamar con lo que el portal usa.
  it('funciona con las definiciones reales del producto', () => {
    const reales = allRecallTemplateDefinitions('https://portal.kairikos.cloud');
    const copiaFiel = reales.map((def) => meta(def.name, def.bodyText));
    expect(findTemplateTextDrift(copiaFiel, reales)).toEqual([]);

    const unaRota = reales.map((def, i) => meta(def.name, i === 0 ? `${def.bodyText} extra` : def.bodyText));
    expect(findTemplateTextDrift(unaRota, reales)).toHaveLength(1);
  });
});
