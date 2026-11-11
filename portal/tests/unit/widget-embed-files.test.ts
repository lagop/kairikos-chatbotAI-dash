// =============================================================================
// Widget v2 — los dos archivos del widget que se sirven tal cual desde
// public/widget/.
//
// embed.js (v1) lo cargan TODOS los clientes desde la misma URL: cualquier
// cambio les llega a la vez y sin aviso. Cuando hizo falta más (webs
// Signature: botón propio, marca, inglés, enlaces, eventos) se decidió hacerlo
// en embed.v2.js y dejar embed.js congelado. Este test lo hace cumplir: si
// necesitas cambiar embed.js de verdad, cambia también el hash aquí y explica
// en el commit por qué el cambio tiene que llegar a todos los clientes.
//
// El hash se calcula con los finales de línea normalizados a LF: en Windows la
// copia de trabajo lleva CRLF (core.autocrlf) y en CI no.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import path from 'node:path';

const WIDGET_DIR = path.resolve(__dirname, '../../public/widget');

function read(name: string): string {
  return readFileSync(path.join(WIDGET_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

describe('public/widget/embed.js (v1)', () => {
  it('no ha cambiado ni un byte', () => {
    const hash = createHash('sha256').update(read('embed.js')).digest('hex');
    expect(hash).toBe('e12f3968ed987650df70bbf563c6deb52748ee64aa13be4bc6a44e6792065129');
  });
});

describe('public/widget/embed.v2.js', () => {
  const source = read('embed.v2.js');

  it('es JavaScript que el navegador puede compilar', () => {
    expect(() => new Script(source, { filename: 'embed.v2.js' })).not.toThrow();
  });

  // El texto del bot se convierte en nodos uno a uno: con innerHTML, una
  // respuesta con <img onerror> sería código ejecutándose en la web del
  // cliente.
  it('no usa innerHTML, outerHTML, insertAdjacentHTML ni document.write', () => {
    expect(source).not.toMatch(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/);
  });

  // Los eventos los escucha la analítica de la web: nunca el texto de los
  // mensajes ni el contacto. Se comprueba la forma de cada emit().
  it('los eventos solo llevan role/mode/href, nunca texto ni contacto', () => {
    const emits = source.match(/emit\('[a-z_]+'[^;]*\)/g) ?? [];
    const names = emits.map((e) => /emit\('([a-z_]+)'/.exec(e)![1]).sort();
    expect([...new Set(names)]).toEqual([
      'chat_close',
      'chat_contact',
      'chat_link',
      'chat_message',
      'chat_open',
      'chat_ready',
    ]);
    for (const call of emits) {
      expect(call).not.toMatch(/text|message:|trimmed|value|contact:/);
    }
  });

  it('no deja caracteres separadores de línea literales (rompen el parser)', () => {
    const separadores = String.fromCharCode(0x2028, 0x2029);
    for (const ch of separadores) expect(source.includes(ch)).toBe(false);
  });
});
