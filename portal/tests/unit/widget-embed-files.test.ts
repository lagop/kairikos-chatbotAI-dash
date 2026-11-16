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

  // Safari anterior a 16.4 no entiende el lookbehind: una sola regex con
  // (?<= o (?<! hace que el script entero falle al cargar en esos iPhone.
  it('no usa lookbehind en las expresiones regulares', () => {
    expect(source).not.toMatch(/\(\?<[=!]/);
  });

  it('no deja caracteres separadores de línea literales (rompen el parser)', () => {
    const separadores = String.fromCharCode(0x2028, 0x2029);
    for (const ch of separadores) expect(source.includes(ch)).toBe(false);
  });
});

// =============================================================================
// Idiomas de embed.v2.js (alemán desde el 15/11/2026).
//
// No hay DOM en estos tests: el script se ejecuta en un contexto de node:vm con
// lo justo para que arranque (el <script> con sus data-*, y un fetch que
// apunta la URL y no contesta nunca). Basta para ver qué idioma eligió: lo
// dice la URL de configuración que pide.
// =============================================================================

/** Un objeto literal del fuente (`var NOMBRE = {...};`), evaluado. */
function literal(source: string, name: string): Record<string, Record<string, string>> {
  const start = source.indexOf(`  var ${name} = {`);
  const end = source.indexOf('\n  };\n', start);
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, end + 5).replace(`var ${name} =`, `globalThis.out =`);
  const ctx: { out?: Record<string, Record<string, string>> } = {};
  new Script(body).runInNewContext(ctx);
  return ctx.out!;
}

/** La URL de configuración que pide el widget con estos data-*. */
function configUrlFor(attrs: Record<string, string>): string {
  const source = read('embed.v2.js');
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    document: {
      readyState: 'complete',
      currentScript: {
        src: 'https://portal.example/widget/embed.v2.js',
        getAttribute: (name: string) => ({ 'data-space-token': 'wgt_test', ...attrs })[name] ?? null,
      },
    },
    fetch: (url: string) => {
      calls.push(url);
      return new Promise(() => {});
    },
    URL,
    console,
  };
  ctx.window = ctx;
  new Script(source, { filename: 'embed.v2.js' }).runInNewContext(ctx);
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('embed.v2.js — idiomas', () => {
  const source = read('embed.v2.js');
  const texts = literal(source, 'TEXTS');
  const replies = literal(source, 'SERVER_REPLIES');

  it('tiene interfaz en español, inglés y alemán', () => {
    expect(Object.keys(texts)).toEqual(['es', 'en', 'de']);
  });

  it('cada idioma tiene exactamente las mismas claves que el español, sin textos vacíos', () => {
    const claves = Object.keys(texts.es).sort();
    for (const [lang, t] of Object.entries(texts)) {
      expect(Object.keys(t).sort(), lang).toEqual(claves);
      for (const [k, v] of Object.entries(t)) expect(v.trim(), `${lang}.${k}`).not.toBe('');
    }
  });

  // Las respuestas de reserva del servidor están en español: cualquier otro
  // idioma de la interfaz necesita su traducción completa.
  it('cada idioma que no es español traduce todas las respuestas de reserva del servidor', () => {
    const modos = ['cap', 'fallback', 'fallbackContact', 'human', 'unavailable'];
    for (const lang of Object.keys(texts).filter((l) => l !== 'es')) {
      expect(Object.keys(replies[lang] ?? {}).sort(), lang).toEqual(modos);
    }
  });

  it('sin data-lang, en español pide la configuración igual que v1 (sin ?lang)', () => {
    expect(configUrlFor({})).toBe('https://portal.example/api/public/channels/web/config?token=wgt_test');
    expect(configUrlFor({ 'data-lang': 'es' })).not.toContain('lang=');
  });

  it('data-lang="en" y data-lang="de" piden la configuración en su idioma', () => {
    expect(configUrlFor({ 'data-lang': 'en' })).toMatch(/&lang=en$/);
    expect(configUrlFor({ 'data-lang': 'de' })).toMatch(/&lang=de$/);
  });

  it('acepta la etiqueta con región o en mayúsculas («de-AT», «EN»)', () => {
    expect(configUrlFor({ 'data-lang': 'de-AT' })).toMatch(/&lang=de$/);
    expect(configUrlFor({ 'data-lang': 'EN' })).toMatch(/&lang=en$/);
  });

  it('un idioma que no tiene cae en español', () => {
    expect(configUrlFor({ 'data-lang': 'fr' })).not.toContain('lang=');
    expect(configUrlFor({ 'data-lang': 'constructor' })).not.toContain('lang=');
  });
});
