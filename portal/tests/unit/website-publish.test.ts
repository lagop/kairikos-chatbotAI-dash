// =============================================================================
// Producto Web, Fase 1 — unit tests de la construcción del sitio y de las
// guardas de la publicación por SFTP.
//
// Dos cosas se juegan aquí, y ninguna es cosmética:
//
// 1. Que el sitio publicado NO dependa del portal. Una web de cliente que
//    pida la foto de portada a nuestro servidor se cae cuando se cae nuestra
//    VPS, y nos regala tráfico ajeno. Es justo lo que este diseño evita.
// 2. Que el servidor no se conecte a donde no debe. isPublishableHost es el
//    equivalente de safePublicUrl: sin él, guardar una credencial con host
//    127.0.0.1 convierte la publicación en una puerta a la red interna.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { stripDraftChrome, hasPortalReferences, buildWebsiteFiles } from '@/lib/website-build';
import { isPublishableHost, normalizeRemotePath } from '@/lib/website-publish';

const COPY = {
  headline: 'Fontanería en Elche, urgencias en menos de 60 minutos',
  subheadline: 'Reparaciones, calderas y desatascos.',
  about: 'Taller propio en el centro.',
  services: [{ name: 'Urgencias', description: 'Atención el mismo día.' }],
  callToAction: 'Llámanos ahora',
};

describe('buildWebsiteFiles', () => {
  const input = {
    businessName: 'Fontanería Ejemplo',
    primaryType: 'plumber',
    themeKey: 'trades-2',
    phone: '+34600112233',
    address: 'Calle Mayor 1',
    city: 'Elche',
    copy: COPY,
    generatedAt: new Date('2026-09-24'),
  };

  it('el sitio es autónomo: ni una referencia al portal', async () => {
    const files = await buildWebsiteFiles(input);
    const html = files.find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(hasPortalReferences(html)).toBe(false);
  });

  it('la portada viaja con el sitio, no se enlaza a la nuestra', async () => {
    const files = await buildWebsiteFiles(input);
    expect(files.map((f) => f.path)).toContain('assets/portada.jpg');
    const html = files[0].content.toString('utf8');
    expect(html).toContain('assets/portada.jpg');
  });

  it('index.html va primero: es lo que hace que el sitio funcione en cuanto sube', async () => {
    const files = await buildWebsiteFiles(input);
    expect(files[0].path).toBe('index.html');
  });

  it('el sitio publicado no lleva la banda de propuesta ni el precio', async () => {
    const files = await buildWebsiteFiles(input);
    const html = files[0].content.toString('utf8');
    expect(html).not.toContain('Propuesta de Kairikos');
    expect(html).not.toContain('todavía no publicado');
    expect(html).not.toContain('490 €');
  });

  it('sigue siendo la misma página que se le enseñó: titular, servicios y teléfono', async () => {
    const files = await buildWebsiteFiles(input);
    const html = files[0].content.toString('utf8');
    expect(html).toContain('urgencias en menos de 60 minutos');
    expect(html).toContain('Urgencias');
    expect(html).toContain('600 11 22 33');
  });
});

describe('stripDraftChrome', () => {
  it('no toca un HTML que ya viene limpio', () => {
    const html = '<html><body><h1>Hola</h1></body></html>';
    expect(stripDraftChrome(html)).toBe(html);
  });
});

describe('isPublishableHost', () => {
  it('acepta un alojamiento normal', () => {
    expect(isPublishableHost('ftp.midominio.es')).toBe(true);
    expect(isPublishableHost('82.223.10.44')).toBe(true);
  });

  it('rechaza la red interna: esto decide a dónde se conecta el servidor', () => {
    expect(isPublishableHost('localhost')).toBe(false);
    expect(isPublishableHost('127.0.0.1')).toBe(false);
    expect(isPublishableHost('10.0.0.5')).toBe(false);
    expect(isPublishableHost('192.168.1.10')).toBe(false);
    expect(isPublishableHost('172.17.0.2')).toBe(false);
    expect(isPublishableHost('169.254.169.254')).toBe(false);
    expect(isPublishableHost('postgres')).toBe(false);
    expect(isPublishableHost('servidor.local')).toBe(false);
    expect(isPublishableHost('')).toBe(false);
  });
});

describe('normalizeRemotePath', () => {
  it('deja un directorio absoluto y sin barra final', () => {
    expect(normalizeRemotePath('/public_html/')).toBe('/public_html');
    expect(normalizeRemotePath('public_html')).toBe('/public_html');
    expect(normalizeRemotePath('  /www/sitio//  ')).toBe('/www/sitio');
  });

  it('vacío significa la raíz, no una ruta rota', () => {
    expect(normalizeRemotePath('')).toBe('/');
    expect(normalizeRemotePath('   ')).toBe('/');
  });
});
