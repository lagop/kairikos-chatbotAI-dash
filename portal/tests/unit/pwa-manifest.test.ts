// =============================================================================
// Fase 5a — tests de la PWA.
//
// Vigilan las DOS decisiones de este trabajo que son caras de revertir, no
// la redacción del manifest:
//
//   1. EL ÁMBITO. `scope` y `start_url` son de las pocas cosas de una PWA
//      que no se pueden cambiar sin consecuencias: ampliarlas después
//      puede leerse como otra aplicación distinta y deja las
//      instalaciones existentes inconsistentes. Se decidió `/portal` — ni
//      más estrecho (el cliente con varios productos quiere una app) ni
//      más ancho (el panel de operador no es suyo).
//
//   2. QUE EL SERVICE WORKER NO CACHEE. Un worker que sirva copias
//      guardadas en un panel de datos enseña llamadas ya devueltas y
//      esconde las que acaban de entrar. Y uno que se cachee a sí mismo
//      deja al usuario clavado en una versión vieja que NO se arregla
//      desplegando. Es de los pocos fallos de frontend que sobreviven a
//      un despliegue correcto.
//
// El segundo se comprueba leyendo el fichero, porque no hay forma de
// ejercitar un service worker en una suite que corre en Node sin DOM — y
// el fallo que importa es que alguien AÑADA caché, no que la existente se
// comporte mal.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '@/app/manifest';

describe('el manifest', () => {
  const m = manifest();

  it('tiene el ámbito en /portal: ni el producto suelto ni el sitio entero', () => {
    expect(m.scope).toBe('/portal');
    expect(m.start_url).toBe('/portal');
  });

  it('NO abarca /admin — el panel de operador no es la app del cliente', () => {
    expect(m.scope?.startsWith('/admin')).toBe(false);
    expect(m.scope).not.toBe('/');
  });

  it('se abre como aplicación, no como pestaña', () => {
    expect(m.display).toBe('standalone');
  });

  // El criterio de instalación de Chrome: al menos un icono de 192 o más.
  it('lleva un icono suficientemente grande para que Chrome ofrezca instalar', () => {
    const sizes = (m.icons ?? []).map((i) => Number(String(i.sizes).split('x')[0]));
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(192);
  });

  // Sin un icono maskable, Android recorta el cuadrado dentro de su propia
  // forma y se come los bordes del dibujo.
  it('declara un icono maskable para que Android no lo recorte mal', () => {
    expect((m.icons ?? []).some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('el nombre corto cabe debajo del icono sin puntos suspensivos', () => {
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
  });

  it('el color de tema coincide con el del layout raíz, o se ve una costura', () => {
    expect(m.theme_color).toBe('#F3F4FA');
  });
});

describe('el service worker', () => {
  const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
  // Sin comentarios: la cabecera del fichero habla mucho de caché
  // justamente para explicar por qué NO la usa.
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // El guardia del guardia: si el borrado de comentarios se comiera el
  // fichero, todo lo de abajo pasaría en verde sin mirar nada.
  it('el escáner encuentra el worker', () => {
    expect(code).toMatch(/addEventListener\(['"]fetch['"]/);
    expect(code).toMatch(/addEventListener\(['"]install['"]/);
  });

  it('tiene un manejador de fetch, que es lo que Chrome exige para ofrecer instalar', () => {
    expect(code).toMatch(/addEventListener\(['"]fetch['"]/);
  });

  it('NO guarda nada en caché', () => {
    // caches.delete() en el activate sí está permitido — es limpieza.
    expect(code).not.toMatch(/caches\.open|cache\.put|cache\.add/);
  });

  it('no intercepta las respuestas: deja pasar todo a la red', () => {
    expect(code).not.toMatch(/respondWith/);
  });

  it('se activa sin esperar a que se cierren las pestañas — es el interruptor de emergencia', () => {
    // Sin skipWaiting, publicar un worker que se desregistre a sí mismo no
    // surtiría efecto hasta que el usuario cerrara todo. Un worker roto
    // pasaría de ser un problema de un despliegue a uno permanente.
    expect(code).toMatch(/skipWaiting/);
    expect(code).toMatch(/clients\.claim/);
  });
});
