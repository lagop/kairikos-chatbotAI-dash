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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { stripDraftChrome, hasPortalReferences, buildWebsiteFiles, buildDesignedWebsiteFiles } from '@/lib/website-build';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { tradeHeroPhoto } from '@/lib/trade-photos';
import {
  isPublishableHost,
  normalizeRemotePath,
  withDeadline,
  SFTP_CONNECT_TIMEOUT_MS,
} from '@/lib/website-publish';

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
    expect(html).not.toContain('/web-draft/');
  });

  it('la portada es la de su oficio, la misma que vio en el borrador', async () => {
    const files = await buildWebsiteFiles(input);
    const photo = tradeHeroPhoto('trades', input.businessName, input.primaryType) as string;
    expect(photo).toMatch(/^\/web-draft\/oficios\/fontaneria-/);
    const hero = files.find((f) => f.path === 'assets/portada.jpg')!;
    expect(hero.content.equals(readFileSync(join(process.cwd(), 'public', photo)))).toBe(true);
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

// =============================================================================
// 24/09/2026 — encontrado al probar la subida contra un servidor SFTP de
// verdad por primera vez (tests/real/sftp-publish.test.ts).
//
// `readyTimeout` de ssh2 no cubre el caso que de verdad pasa: un host mal
// tecleado por el cliente, donde nadie contesta el SYN y el socket se queda
// reintentando lo que decida el sistema operativo. La prueba real se colgó
// 60 segundos enteros con readyTimeout puesto a 20.
//
// Se prueba el corte, no la red: withDeadline es puro y se exporta justo
// para eso.
// =============================================================================
describe('withDeadline', () => {
  it('deja pasar el valor cuando la promesa llega a tiempo', async () => {
    await expect(withDeadline(Promise.resolve('listo'), 1000, 'tarde')).resolves.toBe('listo');
  });

  it('corta la que no termina nunca, con el motivo puesto', async () => {
    await expect(withDeadline(new Promise(() => {}), 20, 'sftp_connect_timeout')).rejects.toThrow(
      'sftp_connect_timeout',
    );
  });

  it('un rechazo propio llega tal cual, sin disfrazarse de tiempo agotado', async () => {
    await expect(withDeadline(Promise.reject(new Error('auth')), 1000, 'tarde')).rejects.toThrow('auth');
  });

  it('el tope de conexión es el mismo que el readyTimeout: no hay dos números que se contradigan', () => {
    expect(SFTP_CONNECT_TIMEOUT_MS).toBe(20000);
  });
});

describe('buildDesignedWebsiteFiles con el logo y las fotos del cliente', () => {
  const logo = 'assets/subidas/0123456789abcdef01.png';
  const portada = 'assets/subidas/abcdefabcdefabcdef.jpg';
  const base = {
    template: SITE_TEMPLATE_BASE,
    businessName: 'Fontanería Ejemplo',
    primaryType: 'plumber',
    themeKey: 'trades-1',
    phone: null,
    address: null,
    now: new Date('2026-10-28'),
  };

  it('las subidas viajan con la web y la portada propia sustituye a la de su oficio', async () => {
    const files = await buildDesignedWebsiteFiles({
      ...base,
      content: { ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo, portada } },
      uploads: [
        { path: logo, content: Buffer.from('logo') },
        { path: portada, content: Buffer.from('foto') },
      ],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([logo, portada]));
    expect(paths).not.toContain('assets/portada.jpg');
    const home = files.find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(home).toContain(`<img src="${logo}"`);
    expect(home).toContain(portada);
    expect(hasPortalReferences(home)).toBe(false);
  });

  it('sin subidas, la de su oficio como hasta ahora', async () => {
    const files = await buildDesignedWebsiteFiles({ ...base, content: SITE_CONTENT_SAMPLES.normal });
    expect(files.map((f) => f.path)).toContain('assets/portada.jpg');
    expect(files.some((f) => f.path.startsWith('assets/subidas/'))).toBe(false);
  });
});
