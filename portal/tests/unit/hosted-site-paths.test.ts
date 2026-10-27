import { describe, expect, it } from 'vitest';
import { isPortalHost, resolveRequestedFile, rewriteRelativeUrls } from '@/lib/hosted-site-paths';

describe('resolveRequestedFile', () => {
  it('sin ruta es la portada; sin extensión es una página', () => {
    expect(resolveRequestedFile(undefined)).toBe('index.html');
    expect(resolveRequestedFile([])).toBe('index.html');
    expect(resolveRequestedFile(['servicios'])).toBe('servicios/index.html');
    expect(resolveRequestedFile(['servicios', 'desatascos'])).toBe('servicios/desatascos/index.html');
    expect(resolveRequestedFile(['assets', 'portada.jpg'])).toBe('assets/portada.jpg');
  });
});

describe('rewriteRelativeUrls', () => {
  it('resuelve las relativas contra la carpeta de la página y deja las demás', () => {
    const html =
      '<img src="assets/portada.jpg"><a href="../">Inicio</a><a href="#contacto">C</a><a href="tel:+34600">T</a>' +
      '<a href="https://ejemplo.es">E</a><link href="https://fonts.googleapis.com/x"><a href="/otra">O</a>';
    expect(rewriteRelativeUrls(html, '/sitios/suarez/servicios/')).toBe(
      '<img src="/sitios/suarez/servicios/assets/portada.jpg"><a href="/sitios/suarez/">Inicio</a><a href="#contacto">C</a><a href="tel:+34600">T</a>' +
        '<a href="https://ejemplo.es">E</a><link href="https://fonts.googleapis.com/x"><a href="/otra">O</a>',
    );
  });

  it('la foto de la portada carga sin la barra final que quita Next.js', () => {
    expect(rewriteRelativeUrls('<img src="assets/portada.jpg">', '/sitios/suarez/')).toBe('<img src="/sitios/suarez/assets/portada.jpg">');
  });
});

describe('isPortalHost', () => {
  it('solo reescribe por la dirección del portal, no por un dominio propio', () => {
    expect(isPortalHost('portal.kairikos.cloud', 'https://portal.kairikos.cloud')).toBe(true);
    expect(isPortalHost('localhost:3003', undefined)).toBe(true);
    expect(isPortalHost('fontaneriasuarez.es', 'https://portal.kairikos.cloud')).toBe(false);
    expect(isPortalHost(null, 'https://portal.kairikos.cloud')).toBe(false);
  });
});
